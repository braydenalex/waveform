// Popup script - handles UI and communication with content/background scripts

let currentTabId = null;
let currentDomain = null;
let currentSettings = { volume: 100, method: 'webaudio' };

// DOM Elements
const volumeSlider = document.getElementById('volumeSlider');
const volumeValue = document.getElementById('volumeValue');
const domainEl = document.getElementById('domain');
const methodBtns = document.querySelectorAll('.method-btn');
const quickBtns = document.querySelectorAll('.quick-btn');

// Initialize popup
async function init() {
    try {
        // Get current tab info from background
        const response = await browser.runtime.sendMessage({ type: 'getTabInfo' });

        if (response.error) {
            domainEl.textContent = 'Unable to access tab';
            return;
        }

        currentTabId = response.tabId;
        currentDomain = response.domain;
        currentSettings = response.settings;

        // Update UI
        domainEl.textContent = currentDomain || 'Unknown site';
        updateVolumeUI(currentSettings.volume);
        updateMethodUI(currentSettings.method);

    } catch (err) {
        console.error('Init error:', err);
        domainEl.textContent = 'Error loading';
    }
}

// Update volume display
function updateVolumeUI(volume) {
    volumeSlider.value = volume;
    volumeValue.textContent = volume;

    // Add boost indicator for >100%
    if (volume > 100) {
        volumeValue.classList.add('boost');
    } else {
        volumeValue.classList.remove('boost');
    }

    // Update slider background gradient
    const percent = (volume / 200) * 100;
    volumeSlider.style.background = `linear-gradient(to right, #4da6ff ${percent}%, #2a2a4a ${percent}%)`;
}

// Update method button UI
function updateMethodUI(method) {
    methodBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.method === method);
    });
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

        // Save to storage
        await browser.runtime.sendMessage({
            type: 'saveSettings',
            domain: currentDomain,
            settings: currentSettings
        });
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
        setVolume(currentSettings.volume, method);
    });
});

// Event: Quick volume buttons
quickBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const volume = parseInt(btn.dataset.volume);
        updateVolumeUI(volume);
        setVolume(volume);
    });
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    let newVolume = currentSettings.volume;

    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        newVolume = Math.min(200, newVolume + 5);
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
