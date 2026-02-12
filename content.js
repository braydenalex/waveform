// Content script - runs in page context
// Handles communication between popup and audio injector

let currentVolume = 100;
let currentMethod = 'both';
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
    ready: `waveform:ready:${injectorChannelToken}`
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

    script.onload = () => {
        injectorReady = true;
        script.remove();
        applyVolume();
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
        method: currentMethod
    });
}

// Set volume using the specified method
function setVolume(volume, method) {
    currentVolume = volume;
    currentMethod = method;
    applyVolume();
}

// Listen for messages from popup
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
        return false;
    }

    if (message.type === 'setVolume') {
        setVolume(message.volume, message.method);
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
