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

// Inject the audio-injector.js into the page context before anything else
function injectAudioScript() {
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('audio-injector.js');
    script.async = false;

    const target = document.head || document.documentElement;
    target.insertBefore(script, target.firstChild);

    script.onload = () => {
        injectorReady = true;
        script.remove();
        applyVolume();
        requestAudioState();
    };

    script.onerror = (e) => {
        console.error('[Volume Control] Failed to inject audio script:', e);
    };
}

// Request audio state from injector
function requestAudioState() {
    window.postMessage({ type: 'VOLUME_CONTROL_GET_STATE' }, '*');
}

// Apply volume to page
function applyVolume() {
    window.postMessage({
        type: 'VOLUME_CONTROL_SET',
        volume: currentVolume / 100,
        method: currentMethod
    }, '*');
}

// Set volume using the specified method
function setVolume(volume, method) {
    currentVolume = volume;
    currentMethod = method;
    applyVolume();
}

// Listen for messages from popup
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'setVolume') {
        setVolume(message.volume, message.method);
        sendResponse({ success: true });
    }

    if (message.type === 'getStatus') {
        sendResponse({
            volume: currentVolume,
            method: currentMethod,
            ready: injectorReady,
            audioState: audioState
        });
    }

    if (message.type === 'getAudioState') {
        requestAudioState();
        // Small delay to allow state to be collected
        setTimeout(() => {
            sendResponse({ audioState: audioState });
        }, 100);
        return true; // Keep channel open for async response
    }

    return true;
});

// Listen for messages from injector
window.addEventListener('message', (event) => {
    // Only accept messages from the same window
    if (event.source !== window) return;

    // Validate message structure
    if (!event.data || typeof event.data !== 'object') return;
    if (typeof event.data.type !== 'string') return;

    if (event.data.type === 'VOLUME_CONTROL_READY') {
        injectorReady = true;
        console.log('[Volume Control] Injector ready');
    }

    if (event.data.type === 'VOLUME_CONTROL_AUDIO_STATE') {
        if (event.data.audioState && typeof event.data.audioState === 'object') {
            audioState = event.data.audioState;
            try {
                browser.runtime.sendMessage({
                    type: 'audioStateUpdate',
                    audioState: audioState
                });
            } catch (e) {
                // Popup might not be open
            }
        }
    }
});

// Inject immediately
injectAudioScript();
