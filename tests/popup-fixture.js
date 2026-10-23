// Deterministic browser responses for popup interaction tests, not playback tests.
window.fixture = {
    settings: { volume: 100, method: 'both', nativeVolumeControl: true },
    state: {
        ready: true, mediaCount: 3, playbackCount: 1, controllableMediaCount: 2,
        hasHTML5Video: true, html5VideoCount: 2, hasHTML5Audio: true, html5AudioCount: 1,
        hasWebAudio: true, webAudioContextCount: 1,
        streamType: { type: 'DASH' },
        detectedCodecs: [{ type: 'video', codec: 'VP9' }, { type: 'audio', codec: 'Opus' }],
        effectiveMethod: 'site', effectiveVolume: null, boostAvailable: true,
        failureReason: null, reloadRequired: false
    },
    storage: {}, messages: [], listeners: [], errors: [],
    emit(state = {}, settings = {}, tabId = 7) {
        if (tabId === 7) {
            Object.assign(this.state, state);
            Object.assign(this.settings, settings);
        }
        for (const listener of this.listeners) listener({ type: 'tabStateUpdate', tabId, audioState: { ...this.state, ...state }, settings: { ...this.settings, ...settings } });
    }
};
addEventListener('error', event => fixture.errors.push(event.message));
addEventListener('unhandledrejection', event => fixture.errors.push(String(event.reason)));
window.browser = {
    runtime: {
        getManifest: () => ({ version: '1.3.0' }),
        onMessage: { addListener: listener => fixture.listeners.push(listener) },
        async sendMessage(request) {
            fixture.messages.push(structuredClone(request));
            if (request.type === 'getTabInfo') return { tabId: 7, domain: 'www.example.com', hasRuntimeSettings: true, settings: { ...fixture.settings }, audioState: { ...fixture.state } };
            if (request.type === 'getTabStatus') return { audioState: { ...fixture.state } };
            if (fixture.delayNext) {
                fixture.delayNext = false;
                await new Promise(resolve => { fixture.release = resolve; });
            }
            if (fixture.failNext) { fixture.failNext = false; return { success: false, error: 'The player did not respond.' }; }
            if (request.type === 'updateTabSettings') Object.assign(fixture.settings, request.settings);
            if (['restoreSiteAudio', 'reloadPage'].includes(request.type)) {
                fixture.settings.nativeVolumeControl = true;
                fixture.storage['www.example.com'] = { ...fixture.settings };
            }
            fixture.state.effectiveMethod = fixture.settings.nativeVolumeControl ? 'site' : fixture.settings.volume > 100 && fixture.state.boostAvailable ? 'webaudio' : 'html5';
            fixture.state.effectiveVolume = fixture.settings.nativeVolumeControl ? null : fixture.state.boostAvailable ? fixture.settings.volume : Math.min(100, fixture.settings.volume);
            return { success: true, settings: { ...fixture.settings }, audioState: { ...fixture.state } };
        }
    },
    storage: { local: {
        async get(key) { return structuredClone(key ? { [key]: fixture.storage[key] } : fixture.storage); },
        async set(values) { Object.assign(fixture.storage, structuredClone(values)); },
        async remove(keys) { for (const key of keys) delete fixture.storage[key]; }
    } }
};
