// Content script - runs in page context
// Handles communication between popup and audio injector

let currentVolume = 100;
let currentMethod = 'both';
let nativeVolumeControl = true;
let injectorReady = false;
let audioState = {
    hasWebAudio: false,
    hasHTML5Audio: false,
    hasHTML5Video: false,
    webAudioContextCount: 0,
    html5AudioCount: 0,
    html5VideoCount: 0
};
let lastAudioStateSignature = '';

function generateChannelToken() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
        globalThis.crypto.getRandomValues(bytes);
        return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const injectorChannelToken = generateChannelToken();
const injectorEvents = {
    command: `waveform:command:${injectorChannelToken}`,
    state: `waveform:state:${injectorChannelToken}`,
    ready: `waveform:ready:${injectorChannelToken}`,
    nativeTouched: `waveform:native-volume-touched:${injectorChannelToken}`
};

function sendInjectorCommand(type, payload = {}) {
    const detail = JSON.stringify({ type, ...payload });
    window.dispatchEvent(new CustomEvent(injectorEvents.command, {
        detail
    }));
}

// Inject the audio-injector.js into the page context before anything else
function injectAudioScript() {
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('audio-injector.js');
    script.async = false;
    script.dataset.waveformChannel = injectorChannelToken;

    const target = document.head || document.documentElement;
    target.insertBefore(script, target.firstChild);

    script.onload = async () => {
        injectorReady = true;
        script.remove();
        await syncSettingsFromBackground();
        applyVolume();
        applyNativeControl();
        requestAudioState();
    };

    script.onerror = (e) => {
        console.error('[Waveform] Failed to inject audio script:', e);
    };
}

// Request audio state from injector
function requestAudioState() {
    sendInjectorCommand('get-state');
}

// Apply volume to page
function applyVolume() {
    sendInjectorCommand('set-volume', {
        volume: currentVolume / 100,
        method: currentMethod,
        nativeVolumeControl
    });
}

function applyNativeControl() {
    sendInjectorCommand('set-native-control', {
        enabled: nativeVolumeControl
    });
}

// Set volume using the specified method
function setVolume(volume, method) {
    const parsedVolume = Number(volume);
    if (Number.isFinite(parsedVolume)) {
        currentVolume = parsedVolume;
    }
    if (typeof method === 'string') {
        currentMethod = method;
    }
    applyVolume();
}

function setNativeVolumeControl(enabled) {
    nativeVolumeControl = !!enabled;
    applyNativeControl();
    applyVolume();
}

async function syncSettingsFromBackground() {
    try {
        const response = await browser.runtime.sendMessage({ type: 'getTabSettingsForSender' });
        if (!response || !response.settings) {
            return;
        }

        const settings = response.settings;
        if (Number.isFinite(Number(settings.volume))) {
            currentVolume = Number(settings.volume);
        }
        if (typeof settings.method === 'string') {
            currentMethod = settings.method;
        }
        nativeVolumeControl = !!settings.nativeVolumeControl;
    } catch (err) {
        // Ignore startup sync failures and continue with defaults.
    }
}

// Listen for messages from popup
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
        return false;
    }

    if (message.type === 'setVolume') {
        if (Object.prototype.hasOwnProperty.call(message, 'nativeVolumeControl')) {
            nativeVolumeControl = !!message.nativeVolumeControl;
            applyNativeControl();
        }
        setVolume(message.volume, message.method);
        sendResponse({ success: true });
        return false;
    }

    if (message.type === 'setNativeVolumeControl') {
        setNativeVolumeControl(message.enabled);
        sendResponse({ success: true });
        return false;
    }

    if (message.type === 'nativeVolumeControlChanged') {
        if (Object.prototype.hasOwnProperty.call(message, 'nativeVolumeControl')) {
            setNativeVolumeControl(message.nativeVolumeControl);
        }
        sendResponse({ success: true });
        return false;
    }

    if (message.type === 'setPersist') {
        sendInjectorCommand('set-persist', {
            persist: message.persist
        });
        sendResponse({ success: true });
        return false;
    }

    if (message.type === 'getStatus') {
        sendResponse({
            volume: currentVolume,
            method: currentMethod,
            nativeVolumeControl,
            ready: injectorReady,
            audioState: audioState
        });
        return false;
    }

    if (message.type === 'getAudioState') {
        requestAudioState();
        // Small delay to allow state to be collected
        setTimeout(() => {
            sendResponse({ audioState: audioState });
        }, 100);
        return true; // Keep channel open for async response
    }

    return false;
});

// Listen for messages from injector via channel-scoped custom events.
window.addEventListener(injectorEvents.ready, () => {
    injectorReady = true;
    console.log('[Waveform] Injector ready');
});

window.addEventListener(injectorEvents.nativeTouched, () => {
    if (nativeVolumeControl) {
        return;
    }

    setNativeVolumeControl(true);
    browser.runtime.sendMessage({
        type: 'nativeVolumeTouched',
        domain: location.hostname
    }).catch(() => {
        // Background might be unavailable briefly during reload.
    });
});

window.addEventListener(injectorEvents.state, (event) => {
    let payload = event.detail;
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch {
            return;
        }
    }
    const nextState = payload && payload.audioState;
    if (nextState && typeof nextState === 'object') {
        const signature = JSON.stringify(nextState);
        if (signature === lastAudioStateSignature) {
            return;
        }
        lastAudioStateSignature = signature;
        audioState = nextState;
        try {
            browser.runtime.sendMessage({
                type: 'audioStateUpdate',
                audioState: audioState
            });
        } catch (e) {
            // Popup might not be open
        }
    }
});

// Inject immediately
injectAudioScript();
