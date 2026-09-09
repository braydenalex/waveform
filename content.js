// Isolated-world bridge. Settings travel as one versioned snapshot; each frame
// owns a port so navigation/removal also removes its status from the background.
const channelToken = crypto.randomUUID();
const events = Object.fromEntries(['command', 'state', 'ready', 'nativeTouched', 'media'].map(name => [name,
    `waveform:${name === 'nativeTouched' ? 'native-volume-touched' : name}:${channelToken}`]));
let injectorReady = false;
let settings = null;
let settingsRevision = 0;
let port = null;
let pageActive = true;
let reconnectTimer = null;
let lastState = { ready: false, failureReason: null, mediaCount: 0 };
const earlyPlayers = new Set();
let discoveryFailed = false;

function announcePlayer(element) {
    // Only page-owned DOM media references cross into the page. No extension
    // objects, storage, messaging functions, or other privileged APIs are exposed.
    if (!(element instanceof window.HTMLMediaElement)) return;
    if (!injectorReady) { if (!discoveryFailed) earlyPlayers.add(element); return; }
    const detail = cloneInto({ element }, window, { wrapReflectors: true });
    window.dispatchEvent(new window.CustomEvent(events.media, { detail }));
}

function discoverEarlyPlayers() {
    // Firefox runs this content script before page scripts, but loading the
    // external injector is asynchronous. Keep media created in that gap, including
    // detached autoplay elements that will never appear in a DOM query.
    if (!window.wrappedJSObject || typeof exportFunction !== 'function' || typeof cloneInto !== 'function') return;
    const page = window.wrappedJSObject;
    const wrap = (owner, name, construct = false) => {
        const original = owner?.[name];
        if (typeof original !== 'function') return;
        const handlers = new window.Object();
        const remember = value => {
            try { announcePlayer(value); } catch { /* Preserve factory behavior. */ }
            return value;
        };
        handlers.apply = exportFunction((target, receiver, args) => remember(Reflect.apply(target, receiver, args)), window);
        if (construct) handlers.construct = exportFunction((target, args, newTarget) => remember(Reflect.construct(target, args, newTarget)), window);
        owner[name] = new window.Proxy(original, handlers);
    };
    try {
        wrap(page, 'Audio', true);
        wrap(page.Document?.prototype, 'createElement');
        wrap(page.Document?.prototype, 'createElementNS');
    } catch { /* The injector still discovers DOM and subsequently played media. */ }
}

function command(type, payload = {}) {
    window.dispatchEvent(new CustomEvent(events.command, { detail: JSON.stringify({ type, ...payload }) }));
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

window.addEventListener(events.ready, () => {
    injectorReady = true;
    clearTimeout(injectionTimeout);
    for (const element of earlyPlayers) {
        try { announcePlayer(element); } catch { /* One stale element must not block settings. */ }
    }
    earlyPlayers.clear();
    applySettings();
    publishState();
});
window.addEventListener(events.state, event => {
    try {
        const payload = JSON.parse(event.detail);
        if (!payload?.audioState || typeof payload.audioState !== 'object') return;
        lastState = payload.audioState;
        publishState();
    } catch { /* Ignore malformed page events. */ }
});
window.addEventListener(events.nativeTouched, () => {
    // The injector already handed control back synchronously. Preserve that
    // choice while the background persists it and informs the other frames.
    if (settings) settings = { ...settings, nativeVolumeControl: true };
    try { port?.postMessage({ type: 'nativeVolumeTouched' }); } catch {}
});
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
    discoveryFailed = true;
    earlyPlayers.clear();
    lastState = { ...lastState, ready: false, failureReason: 'injector-unavailable' };
    publishState();
}
const injectionTimeout = setTimeout(injectionFailed, 5000);
function inject() {
    const target = document.head || document.documentElement;
    if (!target) {
        const observer = new MutationObserver(() => {
            if (document.documentElement) { observer.disconnect(); inject(); }
        });
        observer.observe(document, { childList: true, subtree: true });
        return;
    }
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('audio-injector.js');
    script.async = false;
    script.dataset.waveformChannel = channelToken;
    script.onload = () => script.remove(); // Loading is not the ready handshake.
    script.onerror = () => { script.remove(); injectionFailed(); };
    target.insertBefore(script, target.firstChild);
}
discoverEarlyPlayers();
connect();
inject();
