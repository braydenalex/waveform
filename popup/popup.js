// Popup script - handles UI and communication with content/background scripts

let currentTabId = null;
let currentDomain = null;
let currentSettings = { volume: 100, method: 'both' };
let globalSettings = { maxVolume: 1000, rememberSites: true };
let audioState = null;

// DOM Elements
const volumeSlider = document.getElementById('volumeSlider');
const volumeValue = document.getElementById('volumeValue');
const domainEl = document.getElementById('domain');
const methodBtns = document.querySelectorAll('.method-btn');
const quickBtns = document.querySelectorAll('.quick-btn');
const maxLabel = document.getElementById('maxLabel');
const methodWarning = document.getElementById('methodWarning');
const methodHint = document.getElementById('methodHint');
const detectionBadges = document.getElementById('detectionBadges');

// Settings elements
const settingsToggle = document.getElementById('settingsToggle');
const mainPanel = document.getElementById('mainPanel');
const settingsPanel = document.getElementById('settingsPanel');
const backBtn = document.getElementById('backBtn');
const maxVolumeSelect = document.getElementById('maxVolumeSelect');
const rememberSitesToggle = document.getElementById('rememberSites');
const resetBtn = document.getElementById('resetBtn');

// Initialize popup
async function init() {
    try {
        // Load global settings first
        await loadGlobalSettings();

        // Get current tab info from background
        const response = await browser.runtime.sendMessage({ type: 'getTabInfo' });

        if (response.error) {
            domainEl.textContent = 'Unable to access tab';
            return;
        }

        currentTabId = response.tabId;
        currentDomain = response.domain;

        // Get saved settings but always default to 100% volume if no saved settings
        if (globalSettings.rememberSites && response.settings && response.settings.volume !== undefined) {
            currentSettings = response.settings;
        } else {
            // Default: 100% volume, 'both' method
            currentSettings = { volume: 100, method: 'both' };
        }

        // Update UI
        domainEl.textContent = currentDomain || 'Unknown site';
        updateVolumeUI(currentSettings.volume);
        updateMethodUI(currentSettings.method);
        updateMaxVolumeUI();

        // Get audio state from content script
        fetchAudioState();

    } catch (err) {
        console.error('Init error:', err);
        domainEl.textContent = 'Error loading';
    }
}

// Fetch audio state from content script
async function fetchAudioState() {
    try {
        const status = await browser.tabs.sendMessage(currentTabId, { type: 'getStatus' });
        if (status && status.audioState) {
            updateAudioDetectionUI(status.audioState);
        }
    } catch (err) {
        console.log('Could not fetch audio state:', err);
        updateAudioDetectionUI(null);
    }
}

// Update audio detection badges
function updateAudioDetectionUI(state) {
    audioState = state;

    if (!state) {
        detectionBadges.innerHTML = '<span class="badge badge-none">No audio detected</span>';
        return;
    }

    const badges = [];

    if (state.hasWebAudio) {
        let label = 'Web Audio';
        if (state.webAudioContextCount > 1) {
            label += ` <span class="badge-count">(${state.webAudioContextCount})</span>`;
        }
        badges.push(`<span class="badge badge-webaudio">🎵 ${label}</span>`);
    }

    if (state.hasHTML5Video) {
        let label = 'Video';
        if (state.html5VideoCount > 1) {
            label += ` <span class="badge-count">(${state.html5VideoCount})</span>`;
        }
        badges.push(`<span class="badge badge-video">🎬 ${label}</span>`);
    }

    if (state.hasHTML5Audio) {
        let label = 'Audio';
        if (state.html5AudioCount > 1) {
            label += ` <span class="badge-count">(${state.html5AudioCount})</span>`;
        }
        badges.push(`<span class="badge badge-audio">🔈 ${label}</span>`);
    }

    if (badges.length === 0) {
        detectionBadges.innerHTML = '<span class="badge badge-none">No audio detected</span>';
    } else {
        detectionBadges.innerHTML = badges.join('');
    }
}

// Listen for audio state updates from content script
browser.runtime.onMessage.addListener((message) => {
    if (message.type === 'audioStateUpdate') {
        updateAudioDetectionUI(message.audioState);
    }
});

// Load global settings
async function loadGlobalSettings() {
    try {
        const result = await browser.storage.local.get('_globalSettings');
        if (result._globalSettings) {
            globalSettings = { ...globalSettings, ...result._globalSettings };
        }

        // Update settings UI
        maxVolumeSelect.value = globalSettings.maxVolume;
        rememberSitesToggle.checked = globalSettings.rememberSites;
    } catch (err) {
        console.error('Error loading global settings:', err);
    }
}

// Save global settings
async function saveGlobalSettings() {
    try {
        await browser.storage.local.set({ _globalSettings: globalSettings });
    } catch (err) {
        console.error('Error saving global settings:', err);
    }
}

// Update volume display
function updateVolumeUI(volume) {
    // Clamp based on current method
    const maxVol = currentSettings.method === 'html5' ? 100 : globalSettings.maxVolume;
    volume = Math.min(volume, maxVol);

    volumeSlider.value = volume;
    volumeSlider.max = maxVol;
    volumeValue.textContent = volume;

    // Update max label
    maxLabel.textContent = maxVol + '%';

    // Add boost indicator for >100%
    const valueEl = document.querySelector('.volume-value');
    const percentEl = document.querySelector('.volume-percent');
    if (volume > 100) {
        valueEl.classList.add('boost');
        percentEl.classList.add('boost');
    } else {
        valueEl.classList.remove('boost');
        percentEl.classList.remove('boost');
    }

    // Update slider background gradient
    const percent = (volume / maxVol) * 100;
    volumeSlider.style.background = `linear-gradient(to right, #4da6ff ${percent}%, #2a2a4a ${percent}%)`;

    // Mark slider as limited for HTML5
    volumeSlider.classList.toggle('limited', currentSettings.method === 'html5');
}

// Update max volume UI after settings change
function updateMaxVolumeUI() {
    const maxVol = currentSettings.method === 'html5' ? 100 : globalSettings.maxVolume;
    volumeSlider.max = maxVol;
    maxLabel.textContent = maxVol + '%';

    // Clamp current volume if needed
    if (currentSettings.volume > maxVol) {
        currentSettings.volume = maxVol;
        updateVolumeUI(maxVol);
        setVolume(maxVol);
    }
}

// Update method button UI
function updateMethodUI(method) {
    methodBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.method === method);
    });

    // Show/hide HTML5 warning
    if (method === 'html5') {
        methodWarning.style.display = 'block';
        methodHint.style.display = 'none';
        volumeSlider.max = 100;
        maxLabel.textContent = '100%';
        volumeSlider.classList.add('limited');

        // Clamp volume to 100 for HTML5
        if (currentSettings.volume > 100) {
            currentSettings.volume = 100;
            updateVolumeUI(100);
        }
    } else {
        methodWarning.style.display = 'none';
        methodHint.style.display = 'block';
        volumeSlider.max = globalSettings.maxVolume;
        maxLabel.textContent = globalSettings.maxVolume + '%';
        volumeSlider.classList.remove('limited');
    }
}

// Send volume update to content script
async function setVolume(volume, method) {
    currentSettings.volume = volume;
    currentSettings.method = method || currentSettings.method;

    try {
        // Send to content script
        await browser.tabs.sendMessage(currentTabId, {
            type: 'setVolume',
            volume: volume,
            method: currentSettings.method
        });

        // Save to storage if remembering is enabled
        if (globalSettings.rememberSites) {
            await browser.runtime.sendMessage({
                type: 'saveSettings',
                domain: currentDomain,
                settings: currentSettings
            });
        }
    } catch (err) {
        console.error('Error setting volume:', err);
    }
}

// Event: Volume slider change
volumeSlider.addEventListener('input', (e) => {
    const volume = parseInt(e.target.value);
    updateVolumeUI(volume);
    setVolume(volume);
});

// Event: Method button click
methodBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const method = btn.dataset.method;
        currentSettings.method = method;
        updateMethodUI(method);
        updateVolumeUI(currentSettings.volume);
        setVolume(currentSettings.volume, method);
    });
});

// Event: Quick volume buttons
quickBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        let volume = parseInt(btn.dataset.volume);
        const maxVol = currentSettings.method === 'html5' ? 100 : globalSettings.maxVolume;
        volume = Math.min(volume, maxVol);
        updateVolumeUI(volume);
        setVolume(volume);
    });
});

// Event: Settings toggle
settingsToggle.addEventListener('click', () => {
    mainPanel.style.display = 'none';
    settingsPanel.style.display = 'block';
});

// Event: Back button
backBtn.addEventListener('click', () => {
    settingsPanel.style.display = 'none';
    mainPanel.style.display = 'block';
});

// Event: Max volume change
maxVolumeSelect.addEventListener('change', (e) => {
    globalSettings.maxVolume = parseInt(e.target.value);
    saveGlobalSettings();
    updateMaxVolumeUI();
});

// Event: Remember sites toggle
rememberSitesToggle.addEventListener('change', (e) => {
    globalSettings.rememberSites = e.target.checked;
    saveGlobalSettings();
});

// Event: Reset all sites
resetBtn.addEventListener('click', async () => {
    if (confirm('Clear all saved volume settings for all sites?')) {
        try {
            // Get all keys and remove site-specific ones (keep _globalSettings)
            const all = await browser.storage.local.get(null);
            const keysToRemove = Object.keys(all).filter(k => k !== '_globalSettings');
            await browser.storage.local.remove(keysToRemove);
            alert('All site settings cleared!');
        } catch (err) {
            console.error('Error clearing settings:', err);
        }
    }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Only work when main panel is visible
    if (settingsPanel.style.display !== 'none') return;

    const maxVol = currentSettings.method === 'html5' ? 100 : globalSettings.maxVolume;
    let newVolume = currentSettings.volume;

    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        newVolume = Math.min(maxVol, newVolume + 5);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        newVolume = Math.max(0, newVolume - 5);
    } else if (e.key === 'm' || e.key === 'M') {
        newVolume = newVolume > 0 ? 0 : 100;
    } else {
        return;
    }

    updateVolumeUI(newVolume);
    setVolume(newVolume);
});

// Initialize on load
init();
