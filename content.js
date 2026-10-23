// Isolated-world bridge. Settings travel as one versioned snapshot; each frame
// owns a port so navigation/removal also removes its status from the background.
//
// audio-injector.js runs in the page's world as a MAIN-world content script.
// Both scripts run at document_start, before any page script, and the injector
// hands over a private MessagePort with a single window message. Only the first
// handover is accepted, so later page scripts cannot listen in or pose as it.
const BRIDGE_HELLO = 'waveform:bridge:v1';
let bridge = null;
let injectorReady = false;
let settings = null;
let settingsRevision = 0;
let port = null;
let pageActive = true;
let reconnectTimer = null;
let lastState = { ready: false, failureReason: null, mediaCount: 0 };

function command(type, payload = {}) {
    try { bridge?.postMessage(JSON.stringify({ type, ...payload })); }
    catch { /* The page document is gone. */ }
}

function publishState() {
    try { port?.postMessage({ type: 'frameState', audioState: { ...lastState, ready: injectorReady } }); }
    catch { /* onDisconnect schedules a fresh connection and settings handshake. */ }
}

function applySettings() {
    if (!injectorReady || !settings) return;
    command('apply-settings', { revision: ++settingsRevision, settings });
    command('get-state');
}

function connect() {
    if (port || !pageActive) return;
    try {
        const connection = browser.runtime.connect({ name: 'waveform-frame' });
        port = connection;
        connection.onMessage.addListener(message => {
            if (port !== connection) return;
            if (message.type === 'settings') {
                settings = message.settings;
                applySettings();
            } else if (message.type === 'get-state') {
                if (injectorReady) command('get-state');
                else publishState();
            }
        });
        connection.onDisconnect.addListener(() => {
            if (port !== connection) return;
            port = null;
            if (pageActive) reconnectTimer = setTimeout(connect, 500);
        });
        publishState();
    } catch {
        if (pageActive) reconnectTimer = setTimeout(connect, 500);
    }
}

function onInjectorMessage(event) {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'ready') {
        injectorReady = true;
        clearTimeout(injectionTimeout);
        applySettings();
        publishState();
    } else if (payload.type === 'state') {
        if (!payload.audioState || typeof payload.audioState !== 'object') return;
        lastState = payload.audioState;
        publishState();
    } else if (payload.type === 'native-volume-touched') {
        // The injector already handed control back synchronously. Preserve that
        // choice while the background persists it and informs the other frames.
        if (settings) settings = { ...settings, nativeVolumeControl: true };
        try { port?.postMessage({ type: 'nativeVolumeTouched' }); } catch {}
    }
}

window.addEventListener('message', event => {
    if (bridge || event.source !== window || event.data !== BRIDGE_HELLO || event.ports?.length !== 1) return;
    event.stopImmediatePropagation();
    bridge = event.ports[0];
    bridge.onmessage = onInjectorMessage;
}, true);

window.addEventListener('pagehide', () => {
    pageActive = false;
    clearTimeout(reconnectTimer);
    const previous = port;
    port = null;
    previous?.disconnect();
});
window.addEventListener('pageshow', () => {
    pageActive = true;
    connect();
    if (injectorReady) command('get-state');
});

function injectionFailed() {
    if (injectorReady) return;
    lastState = { ...lastState, ready: false, failureReason: 'injector-unavailable' };
    publishState();
}
const injectionTimeout = setTimeout(injectionFailed, 5000);
connect();
