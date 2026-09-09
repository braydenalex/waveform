// Popup script - handles UI and communication with content/background scripts

let currentTabId = null;
let currentDomain = null;
let currentSettings = { volume: 100, method: 'both', nativeVolumeControl: true };
let globalSettings = {
    maxVolume: 1000,
    rememberMethod: true,    // On by default
    rememberVolume: false,   // Off by default (resets to 100%)
    persistVolume: false,    // Off by default (for dynamic sites)
    theme: 'light',          // Light by default
    accessibilityMode: false // Off by default
};
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
const nativeVolumeControlToggle = document.getElementById('nativeVolumeControl');
const nativeControlHint = document.getElementById('nativeControlHint');
const playbackStatus = document.getElementById('playbackStatus');
const volumeCaption = document.getElementById('volumeCaption');
const restoreAudioBtn = document.getElementById('restoreAudioBtn');
const reloadPageBtn = document.getElementById('reloadPageBtn');
let requestQueue = Promise.resolve();
let pendingChanges = 0;

// Settings elements
const settingsToggle = document.getElementById('settingsToggle');
const mainPanel = document.getElementById('mainPanel');
const settingsPanel = document.getElementById('settingsPanel');
const backBtn = document.getElementById('backBtn');
const maxVolumeSelect = document.getElementById('maxVolumeSelect');
const rememberMethodToggle = document.getElementById('rememberMethod');
const rememberVolumeToggle = document.getElementById('rememberVolume');
const persistVolumeToggle = document.getElementById('persistVolume');
const themeSelect = document.getElementById('themeSelect');
const accessibilityToggle = document.getElementById('accessibilityMode');
const resetBtn = document.getElementById('resetBtn');

// Initialize popup
async function init() {
    try {
        await loadGlobalSettings();

        const response = await browser.runtime.sendMessage({ type: 'getTabInfo' });

        if (response.error) {
            domainEl.textContent = 'Unable to access tab';
            return;
        }

        currentTabId = response.tabId;
        currentDomain = response.domain;

        if (response.settings) {
            const validMethods = ['webaudio', 'html5', 'both'];
            const hasRuntimeSettings = !!response.hasRuntimeSettings;

            const method = (hasRuntimeSettings || globalSettings.rememberMethod) && validMethods.includes(response.settings.method)
                ? response.settings.method
                : 'both';

            const maxVolume = method === 'html5' ? 100 : globalSettings.maxVolume;
            const rawVolume = Number(response.settings.volume);
            const volume = (hasRuntimeSettings || globalSettings.rememberVolume) && Number.isFinite(rawVolume)
                ? Math.max(0, Math.min(maxVolume, rawVolume))
                : 100;

            currentSettings = {
                volume: Math.round(volume),
                method,
                nativeVolumeControl: response.settings.nativeVolumeControl !== false
            };
        } else {
            currentSettings = { volume: 100, method: 'both', nativeVolumeControl: true };
        }

        // Update UI
        domainEl.textContent = currentDomain || 'Unknown site';
        updateVolumeUI(currentSettings.volume);
        updateMethodUI(currentSettings.method);
        updateMaxVolumeUI();
        updateNativeControlUI(currentSettings.nativeVolumeControl);

        updateAudioDetectionUI(response.audioState);
        fetchAudioState();

    } catch (err) {
        console.error('Init error:', err);
        domainEl.textContent = 'Error loading';
    }
}

// Fetch audio state from content script
async function fetchAudioState() {
    try {
        const status = await browser.runtime.sendMessage({ type: 'getTabStatus', tabId: currentTabId, domain: currentDomain });
        if (status?.audioState) updateAudioDetectionUI(status.audioState);
    } catch (err) {
        console.log('Could not fetch audio state:', err);
        updateAudioDetectionUI(null);
    }
}

// Sanitize inputs
function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function validateColor(color) {
    if (color && /^#[0-9A-F]{3,8}$/i.test(color)) {
        return color;
    }
    return '#888888';
}

function updateAudioDetectionUI(state) {
    audioState = state;
    updatePlaybackStatus(state);

    if (!state) {
        detectionBadges.innerHTML = '<span class="badge badge-none">No media detected</span>';
        return;
    }

    const badges = [];

    // Stream type badge (HLS, DASH, MP4, etc.)
    if (state.streamType) {
        const st = state.streamType;
        const color = validateColor(st.color);
        const type = escapeHTML(st.type);
        badges.push(`<span class="badge badge-stream" style="background: ${color}20; color: ${color}; border-color: ${color}40;">📡 ${type}</span>`);
    }

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

    // Codec badges
    if (state.detectedCodecs && state.detectedCodecs.length > 0) {
        state.detectedCodecs.forEach(codec => {
            const icon = codec.type === 'video' ? '🎞️' : '🎧';
            const color = validateColor(codec.color);
            const codecName = escapeHTML(codec.codec);
            badges.push(`<span class="badge badge-codec" style="background: ${color}20; color: ${color}; border-color: ${color}40;">${icon} ${codecName}</span>`);
        });
    }

    if (badges.length === 0) {
        detectionBadges.innerHTML = '<span class="badge badge-none">No media detected</span>';
    } else {
        detectionBadges.innerHTML = badges.join('');
    }
}

function updatePlaybackStatus(state) {
    reloadPageBtn.hidden = !state?.reloadRequired;
    volumeCaption.textContent = currentSettings.nativeVolumeControl ? 'Site volume controls' : 'Requested volume';
    if (!state?.ready) {
        playbackStatus.textContent = state?.failureReason === 'injector-unavailable'
            ? 'Waveform could not connect to this player. Site playback is unchanged.'
            : 'Connecting to the player…';
        return;
    }
    if (state.reloadRequired) {
        playbackStatus.textContent = 'Reload needed. Restore site audio, then reload this page to clear the audio route.';
    } else if (['interaction-required', 'resume-failed', 'site-context-suspended'].includes(state.failureReason)) {
        playbackStatus.textContent = 'Click play to resume. Audio processing is waiting for the player.';
    } else if (!state.mediaCount) {
        playbackStatus.textContent = 'No media detected.';
    } else if (currentSettings.nativeVolumeControl) {
        playbackStatus.textContent = 'Site volume controls are active.';
    } else if (state.failureReason === 'no-audio-track') {
        playbackStatus.textContent = 'No audio track detected. The detected video has no audio.';
    } else if (!state.boostAvailable && currentSettings.volume > 100) {
        if (state.effectiveMethod === 'mixed') {
            playbackStatus.textContent = 'Some players are limited to 100%. Boost is applied to the supported players.';
        } else if (state.failureReason === 'protected-media') {
            playbackStatus.textContent = 'Protected audio: boost is disabled to avoid playback failures in Firefox. Volume is limited to 100%.';
        } else if (state.failureReason === 'media-not-ready') {
            playbackStatus.textContent = 'Waiting for the player to load audio before enabling boost.';
        } else if (state.failureReason === 'cors-unverified') {
            playbackStatus.textContent = 'Volume limited to 100%. This source has not been verified for cross-origin audio processing.';
        } else {
            playbackStatus.textContent = 'Volume limited to 100%. Audio processing is unavailable for this source.';
        }
    } else if (state.effectiveVolume !== null && state.effectiveVolume !== undefined) {
        playbackStatus.textContent = `Applied volume: ${Math.round(state.effectiveVolume)}% (${state.effectiveMethod === 'webaudio' ? 'Web Audio' : 'HTML5'}).`;
    } else {
        playbackStatus.textContent = 'Players are using different volume methods.';
    }
}

browser.runtime.onMessage.addListener(message => {
    if (message.type !== 'tabStateUpdate' || message.tabId !== currentTabId) return;
    if (!pendingChanges && message.settings) {
        currentSettings = { ...currentSettings, ...message.settings };
        updateMethodUI(currentSettings.method);
        updateVolumeUI(currentSettings.volume);
        updateNativeControlUI(currentSettings.nativeVolumeControl);
    }
    updateAudioDetectionUI(message.audioState);
});

// Load global settings
async function loadGlobalSettings() {
    try {
        const result = await browser.storage.local.get('_globalSettings');
        if (result._globalSettings) {
            globalSettings = { ...globalSettings, ...result._globalSettings };
        }

        maxVolumeSelect.value = globalSettings.maxVolume;
        rememberMethodToggle.checked = globalSettings.rememberMethod;
        rememberVolumeToggle.checked = globalSettings.rememberVolume;
        persistVolumeToggle.checked = globalSettings.persistVolume;
        themeSelect.value = globalSettings.theme;
        accessibilityToggle.checked = globalSettings.accessibilityMode;

        applyTheme(globalSettings.theme);
        applyAccessibilityMode(globalSettings.accessibilityMode);
    } catch (err) {
        console.error('Error loading global settings:', err);
    }
}

// Apply theme to document
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    setTimeout(() => {
        if (currentSettings) {
            updateVolumeUI(currentSettings.volume);
        }
    }, 50);
}

// Apply accessibility mode to document
function applyAccessibilityMode(enabled) {
    document.documentElement.setAttribute('data-accessibility', enabled.toString());
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
    const maxVol = currentSettings.method === 'html5' ? 100 : globalSettings.maxVolume;
    volume = Math.min(volume, maxVol);

    volumeSlider.value = volume;
    volumeSlider.max = maxVol;
    volumeValue.textContent = volume;

    maxLabel.textContent = maxVol + '%';

    const valueEl = document.querySelector('.volume-value');
    const percentEl = document.querySelector('.volume-percent');
    if (volume > 100) {
        valueEl.classList.add('boost');
        percentEl.classList.add('boost');
    } else {
        valueEl.classList.remove('boost');
        percentEl.classList.remove('boost');
    }

    // Update slider background gradient - get computed styles for theme colors
    const percent = (volume / maxVol) * 100;
    const style = getComputedStyle(document.documentElement);
    const accentColor = style.getPropertyValue('--accent-primary').trim() || '#4da6ff';
    const bgColor = style.getPropertyValue('--bg-tertiary').trim() || '#2a2a4a';
    volumeSlider.style.background = `linear-gradient(to right, ${accentColor} ${percent}%, ${bgColor} ${percent}%)`;

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

function updateNativeControlUI(enabled) {
    const isEnabled = !!enabled;
    currentSettings.nativeVolumeControl = isEnabled;
    nativeVolumeControlToggle.checked = isEnabled;
    mainPanel.classList.toggle('native-control-enabled', isEnabled);

    const controlsToDisable = [volumeSlider, ...methodBtns, ...quickBtns];
    controlsToDisable.forEach(control => {
        control.disabled = isEnabled;
    });

    if (isEnabled) {
        nativeControlHint.textContent = 'Site controls are active. This choice is remembered for this website.';
    } else {
        nativeControlHint.textContent = 'Waveform override is active for this domain. Native site controls are normally on by default.';
    }
}

function sendChange(type, settings) {
    if (!Number.isInteger(currentTabId)) return Promise.resolve();
    const request = { type, tabId: currentTabId, domain: currentDomain, settings };
    pendingChanges++;
    const operation = requestQueue.then(async () => {
        const response = await browser.runtime.sendMessage(request);
        if (!response?.success) throw new Error(response?.error || 'Could not update this tab.');
        return response;
    });
    requestQueue = operation.catch(() => {});
    return operation.then(response => {
        if (pendingChanges === 1 && response.settings) {
            currentSettings = { ...currentSettings, ...response.settings };
            updateMethodUI(currentSettings.method);
            updateVolumeUI(currentSettings.volume);
            updateNativeControlUI(currentSettings.nativeVolumeControl);
        }
        if (response.audioState) updateAudioDetectionUI(response.audioState);
    }).catch(error => {
        playbackStatus.textContent = error.message;
    }).finally(() => { pendingChanges--; });
}

function setNativeVolumeControl(enabled) {
    updateNativeControlUI(enabled);
    return sendChange('updateTabSettings', { nativeVolumeControl: !!enabled });
}

function setVolume(volume, method) {
    currentSettings.volume = volume;
    currentSettings.method = method || currentSettings.method;
    volumeCaption.textContent = 'Requested volume';
    playbackStatus.textContent = 'Applying volume…';
    return sendChange('updateTabSettings', {
        volume, method: currentSettings.method,
        nativeVolumeControl: currentSettings.nativeVolumeControl,
        persistVolume: globalSettings.persistVolume
    });
}

restoreAudioBtn.addEventListener('click', async () => {
    restoreAudioBtn.disabled = true;
    await sendChange('restoreSiteAudio');
    restoreAudioBtn.disabled = false;
});
reloadPageBtn.addEventListener('click', async () => {
    reloadPageBtn.disabled = true;
    await sendChange('reloadPage');
    reloadPageBtn.disabled = false;
});

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

// Event: Native site volume toggle
nativeVolumeControlToggle.addEventListener('change', (e) => {
    setNativeVolumeControl(e.target.checked, { source: 'popup', persist: true });
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

// Event: Remember method toggle
rememberMethodToggle.addEventListener('change', (e) => {
    globalSettings.rememberMethod = e.target.checked;
    saveGlobalSettings();
});

// Event: Remember volume toggle
rememberVolumeToggle.addEventListener('change', (e) => {
    globalSettings.rememberVolume = e.target.checked;
    saveGlobalSettings();
});

// Event: Theme change
themeSelect.addEventListener('change', (e) => {
    globalSettings.theme = e.target.value;
    saveGlobalSettings();
    applyTheme(globalSettings.theme);
});

// Event: Accessibility mode toggle
accessibilityToggle.addEventListener('change', (e) => {
    globalSettings.accessibilityMode = e.target.checked;
    saveGlobalSettings();
    applyAccessibilityMode(globalSettings.accessibilityMode);
});

// Event: Persist volume toggle
persistVolumeToggle.addEventListener('change', (e) => {
    globalSettings.persistVolume = e.target.checked;
    saveGlobalSettings();
    // The background broadcasts this preference to every connected frame.
});

// Event: Reset all sites
resetBtn.addEventListener('click', async () => {
    if (confirm('Clear all saved volume settings for all sites?')) {
        try {
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
    if (currentSettings.nativeVolumeControl) return;

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
