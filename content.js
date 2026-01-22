// Content script - runs in page context
// Handles communication between popup and audio injector

let currentVolume = 100;
let currentMethod = 'webaudio';
let injectorReady = false;

// Inject the audio-injector.js into the page context
function injectAudioScript() {
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('audio-injector.js');
    script.onload = () => {
        injectorReady = true;
        // Apply any pending volume setting
        setVolume(currentVolume, currentMethod);
    };
    (document.head || document.documentElement).appendChild(script);
}

// Set volume using the specified method
function setVolume(volume, method) {
    currentVolume = volume;
    currentMethod = method;

    // Send message to page context
    window.postMessage({
        type: 'VOLUME_CONTROL_SET',
        volume: volume / 100, // Convert percentage to 0-2 range
        method: method
    }, '*');
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
            ready: injectorReady
        });
    }

    return true;
});

// Listen for ready signal from injector
window.addEventListener('message', (event) => {
    if (event.data?.type === 'VOLUME_CONTROL_READY') {
        injectorReady = true;
    }
});

// Inject when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectAudioScript);
} else {
    injectAudioScript();
}
