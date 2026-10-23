// The popup presents requested settings separately from the player's reported state.
let currentTabId = null;
let currentDomain = null;
let currentSettings = { volume: 100, method: 'both', nativeVolumeControl: true };
let globalSettings = {
    maxVolume: 1000, rememberMethod: true, rememberVolume: false,
    persistVolume: false, theme: 'system', accessibilityMode: false
};
let audioState = null;
let lastAudibleVolume = 100;
let requestQueue = Promise.resolve();
let settingsQueue = Promise.resolve();
let pendingChanges = 0;
let lastChangeError = '';
let tabError = '';

const $ = id => document.getElementById(id);
const volumeSlider = $('volumeSlider');
const volumeValue = $('volumeValue');
const methodBtns = document.querySelectorAll('.method-btn');
const quickBtns = document.querySelectorAll('.quick-btn');
const methodNames = { both: 'Auto', html5: 'HTML5', webaudio: 'Web Audio', site: 'Site controls', mixed: 'Mixed methods' };
const maxVolume = () => currentSettings.method === 'html5' ? 100 : globalSettings.maxVolume;
const clampVolume = volume => Math.round(Math.max(0, Math.min(maxVolume(), volume)));
const THEMES = ['system', 'light', 'dark'];

// The slider track is a scale, not the raw percent: 0–100% fills the first
// half, and boost levels use a log scale above that, so 100–500% stays easy to
// reach even with a 10000% maximum. Standard mode (max 100%) stays linear.
const SLIDER_STEPS = 1000;
function volumeToSlider(volume) {
    const max = maxVolume();
    if (max <= 100) return Math.round(volume / max * SLIDER_STEPS);
    if (volume <= 100) return Math.round(volume / 100 * SLIDER_STEPS / 2);
    return Math.round(SLIDER_STEPS / 2 * (1 + Math.log(volume / 100) / Math.log(max / 100)));
}
function sliderToVolume(position) {
    const max = maxVolume();
    const ratio = Math.max(0, Math.min(1, position / SLIDER_STEPS));
    if (max <= 100) return Math.round(ratio * max);
    if (ratio <= .5) return Math.round(ratio * 200);
    const volume = 100 * Math.pow(max / 100, ratio * 2 - 1);
    const step = volume >= 1000 ? 50 : 5; // Round boost levels to friendly numbers.
    return clampVolume(Math.round(volume / step) * step);
}

async function init() {
    $('version').textContent = `v${browser.runtime.getManifest().version}`;
    await loadGlobalSettings();
    try {
        const response = await browser.runtime.sendMessage({ type: 'getTabInfo' });
        if (response?.error || !Number.isInteger(response?.tabId)) throw new Error('Open a website to use Waveform.');
        currentTabId = response.tabId;
        currentDomain = response.domain;
        const saved = response.settings || {};
        const useMethod = response.hasRuntimeSettings || globalSettings.rememberMethod;
        const useVolume = response.hasRuntimeSettings || globalSettings.rememberVolume;
        currentSettings.method = useMethod && ['both', 'html5', 'webaudio'].includes(saved.method) ? saved.method : 'both';
        currentSettings.volume = useVolume && Number.isFinite(Number(saved.volume)) ? clampVolume(Number(saved.volume)) : 100;
        currentSettings.nativeVolumeControl = saved.nativeVolumeControl !== false;
        lastAudibleVolume = currentSettings.volume || 100;
        $('domain').textContent = currentDomain || 'Current tab';
        $('domain').title = currentDomain || 'Current tab';
        audioState = response.audioState || null;
        render();
        try {
            const status = await browser.runtime.sendMessage({ type: 'getTabStatus', tabId: currentTabId, domain: currentDomain });
            if (!pendingChanges && status?.audioState) {
                audioState = status.audioState;
                render();
            }
        } catch (_) { /* Keep the last reported state if a status refresh fails. */ }
    } catch (error) {
        tabError = error.message;
        $('domain').textContent = 'No website selected';
        render();
    }
}

function render() {
    const siteControl = currentSettings.nativeVolumeControl;
    const connected = Number.isInteger(currentTabId);
    $('waveformEnabled').checked = !siteControl;
    $('waveformEnabled').disabled = !connected;
    $('mainPanel').classList.toggle('site-control-enabled', siteControl);
    $('nativeControlHint').textContent = siteControl ? 'Off · using the site’s controls' : 'On for this site';
    $('volumeCaption').textContent = siteControl ? 'Saved volume setting' : 'Requested volume';
    const disabled = siteControl || !connected;
    [volumeSlider, volumeValue, $('decreaseVolume'), $('increaseVolume'), ...methodBtns].forEach(control => { control.disabled = disabled; });
    $('decreaseVolume').disabled = disabled || currentSettings.volume <= 0;
    $('increaseVolume').disabled = disabled || currentSettings.volume >= maxVolume();
    $('restoreAudioBtn').disabled = !connected || pendingChanges > 0;
    $('reloadPageBtn').disabled = !connected || pendingChanges > 0;
    $('reloadPageBtn').hidden = !audioState?.reloadRequired;
    $('version').hidden = !!audioState?.reloadRequired;
    methodBtns.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.method === currentSettings.method)));
    const hints = {
        both: 'Adjusts volume normally. Boosts compatible players above 100%.',
        html5: 'Standard element volume, up to 100%. No Web Audio routing.',
        webaudio: 'Uses Web Audio when supported. Other players stay at 100% or below.'
    };
    $('methodHint').textContent = hints[currentSettings.method] || hints.both;
    document.querySelector('.method-buttons').title = $('methodHint').textContent;
    updateVolumeUI();
    quickBtns.forEach(button => {
        const beyondLimit = Number(button.dataset.volume) > maxVolume();
        button.disabled = disabled || beyondLimit;
        if (button.id !== 'muteBtn') button.title = beyondLimit ? 'Standard mode is limited to 100%' : `Set volume to ${button.dataset.volume}%`;
    });
    updateMediaDetails();
    updatePlaybackStatus();
}

function updateVolumeUI() {
    const volume = currentSettings.volume;
    const position = volumeToSlider(volume);
    volumeSlider.max = SLIDER_STEPS;
    volumeSlider.value = position;
    volumeSlider.setAttribute('aria-valuetext', `${volume}% requested volume`);
    volumeSlider.style.setProperty('--fill', `${position / SLIDER_STEPS * 100}%`);
    $('midLabel').hidden = maxVolume() <= 100;
    volumeValue.max = maxVolume();
    // Live player updates must not replace an unfinished number while it is being typed.
    if (document.activeElement !== volumeValue) volumeValue.value = volume;
    sizeVolumeInput();
    $('maxLabel').textContent = `${maxVolume()}%`;
    quickBtns.forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.volume) === volume)));
    $('muteLabel').textContent = volume === 0 ? 'Unmute' : 'Mute';
    $('muteBtn').title = volume === 0 ? `Restore ${clampVolume(lastAudibleVolume)}% (M)` : 'Mute (M)';
}

function sizeVolumeInput() {
    volumeValue.style.width = `${Math.max(2, Math.min(5, volumeValue.value.length))}ch`;
}

function updateMediaDetails() {
    const state = audioState;
    const count = (key, fallback) => state ? (state[key] ?? (fallback && state[fallback] ? 1 : 0)) : '—';
    $('videoCount').textContent = count('html5VideoCount', 'hasHTML5Video');
    $('audioCount').textContent = count('html5AudioCount', 'hasHTML5Audio');
    $('contextCount').textContent = count('webAudioContextCount', 'hasWebAudio');
    $('playbackCount').textContent = state ? `${state.playbackCount || 0} / ${state.mediaCount || 0}` : '—';
    $('controllableCount').textContent = count('controllableMediaCount');
    $('streamFormat').textContent = state?.streamType?.type || 'Not detected';
    for (const type of ['video', 'audio']) {
        const codecs = (state?.detectedCodecs || []).filter(codec => codec.type === type).map(codec => codec.codec);
        $(type + 'Codecs').textContent = [...new Set(codecs)].join(', ') || 'Not detected';
    }
    $('effectiveMethod').textContent = state?.ready ? (methodNames[state.effectiveMethod] || 'Not reported') : '—';
    const boostLimited = state?.boostAvailable === false && currentSettings.volume > 100;
    const canReportVolume = state?.ready && state.mediaCount > 0 && !state.reloadRequired && !currentSettings.nativeVolumeControl;
    $('effectiveVolume').textContent = !canReportVolume ? '—'
        : boostLimited && state.effectiveMethod === 'mixed' ? 'Varies by player'
        : boostLimited && (!Number.isFinite(state.effectiveVolume) || state.effectiveVolume > 100) ? '100% maximum'
        : Number.isFinite(state.effectiveVolume) ? `${Math.round(state.effectiveVolume)}%` : 'Varies by player';
    $('boostSupport').textContent = !state?.ready || !state.mediaCount ? 'Not determined'
        : state.reloadRequired ? 'Reload needed' : state.boostAvailable ? 'Available'
        : state.effectiveMethod === 'mixed' ? 'Some players only' : 'Unavailable';
    const sources = state?.mediaCount || 0;
    $('mediaSummary').textContent = !state?.ready ? 'Waiting for player' : !sources ? 'No media detected'
        : [state.streamType?.type, `${sources} source${sources === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    $('mediaSummary').title = $('mediaSummary').textContent;
}

function setStatus(title, detail, tone = 'neutral') {
    $('statusTitle').textContent = title;
    $('statusDetail').textContent = detail;
    $('playbackStatus').dataset.tone = tone;
    $('playbackStatus').title = `${title}. ${detail}`;
}

function updatePlaybackStatus() {
    const state = audioState;
    const capability = $('boostStatus');
    capability.dataset.tone = 'neutral';
    if (state?.reloadRequired) { capability.textContent = 'Reload needed'; capability.dataset.tone = 'warning'; }
    else if (!state?.ready || !state.mediaCount) capability.textContent = 'Checking player';
    else if (currentSettings.nativeVolumeControl) capability.textContent = 'Site controls';
    else if (currentSettings.method === 'html5') capability.textContent = 'Up to 100%';
    else if (state.boostAvailable) { capability.textContent = 'Boost supported'; capability.dataset.tone = 'success'; }
    else { capability.textContent = state.effectiveMethod === 'mixed' ? 'Limited boost' : 'Up to 100%'; capability.dataset.tone = 'warning'; }
    capability.title = capability.textContent; // The chip may truncate in large-text mode.

    if (tabError) return setStatus('Open a website', tabError);
    if (lastChangeError) return setStatus('Couldn’t apply changes', lastChangeError, 'error');
    if (pendingChanges) return setStatus('Applying your settings', 'Waiting for the player to report its volume.');
    if (state?.reloadRequired) return setStatus('Reload needed', currentSettings.nativeVolumeControl
        ? 'Site controls are saved. Reload to recover this player.'
        : 'Restore site audio, then reload to recover this player.', 'warning');
    if (!state?.ready) return state?.failureReason === 'injector-unavailable'
        ? setStatus('Player unavailable', 'Waveform couldn’t connect. You can still use the site’s controls.', 'warning')
        : setStatus('Connecting to the player', 'Start playback to let Waveform detect your audio.');
    if (['interaction-required', 'resume-failed', 'site-context-suspended'].includes(state.failureReason)) {
        return setStatus('Click play to resume', 'Audio processing is waiting for interaction with the player.', 'warning');
    }
    if (!state.mediaCount) return setStatus('No media detected', 'Play audio or video on this page to get started.');
    if (currentSettings.nativeVolumeControl) return setStatus('The site is in control', 'Enable Waveform above to adjust volume here.');
    if (state.failureReason === 'no-audio-track') return setStatus('No audio track detected', 'The detected video does not contain audio.');
    if (!state.boostAvailable && currentSettings.volume > 100) {
        const reasons = {
            'protected-media': 'This player uses protected audio. Boost is unavailable.',
            'cors-unverified': 'This source isn’t verified for cross-origin audio processing.',
            'media-not-ready': 'Waiting for the player to load audio before checking boost support.'
        };
        if (state.effectiveMethod === 'mixed') return setStatus('Some players are limited to 100%', 'Only supported players receive the requested boost.', 'warning');
        if (state.failureReason === 'media-not-ready') return setStatus('Waiting for audio', reasons[state.failureReason]);
        return setStatus('Volume limited to 100%', reasons[state.failureReason] || 'Boost is unavailable for this source. Ordinary volume control is still available.', 'warning');
    }
    if (Number.isFinite(state.effectiveVolume)) {
        return setStatus(`Applied volume: ${Math.round(state.effectiveVolume)}%`, `${methodNames[state.effectiveMethod] || 'Player'} control${state.effectiveVolume === 0 ? ' · audio is muted' : ''}.`, 'success');
    }
    setStatus('Players use different controls', 'Open Media details to see the methods and sources detected.');
}

browser.runtime.onMessage.addListener(message => {
    if (message.type !== 'tabStateUpdate' || message.tabId !== currentTabId) return;
    if (!pendingChanges && message.settings) currentSettings = { ...currentSettings, ...message.settings };
    if (message.audioState) audioState = message.audioState;
    render();
});

function sendChange(type, settings) {
    if (!Number.isInteger(currentTabId)) return Promise.resolve(false);
    const request = { type, tabId: currentTabId, domain: currentDomain, settings };
    pendingChanges++;
    lastChangeError = '';
    render();
    const operation = requestQueue.then(async () => {
        const response = await browser.runtime.sendMessage(request);
        if (!response?.success) throw new Error(response?.error || 'Could not update this tab. Try again.');
        return response;
    });
    requestQueue = operation.catch(() => {});
    return operation.then(response => {
        // Earlier responses must not move the controls back while a later change is queued.
        if (pendingChanges === 1) {
            if (response.settings) currentSettings = { ...currentSettings, ...response.settings };
            if (response.audioState) audioState = response.audioState;
            lastChangeError = '';
        }
        return true;
    }).catch(error => {
        if (pendingChanges === 1) lastChangeError = error.message;
        return false;
    }).finally(() => { pendingChanges--; render(); });
}

function setVolume(volume, method = currentSettings.method) {
    if (!Number.isFinite(volume)) return Promise.resolve(false);
    if (currentSettings.volume > 0) lastAudibleVolume = currentSettings.volume;
    currentSettings.method = method;
    currentSettings.volume = clampVolume(volume);
    return sendChange('updateTabSettings', {
        volume: currentSettings.volume, method,
        nativeVolumeControl: currentSettings.nativeVolumeControl,
        persistVolume: globalSettings.persistVolume
    });
}

function toggleMute() { return setVolume(currentSettings.volume === 0 ? lastAudibleVolume : 0); }

volumeSlider.addEventListener('input', event => setVolume(sliderToVolume(Number(event.target.value))));
// Native slider keys would move one scale step, which is not a whole percent.
// Handle them here so each press is a predictable volume change.
volumeSlider.addEventListener('keydown', event => {
    const steps = { ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5, PageUp: 25, PageDown: -25 };
    if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        setVolume(event.key === 'Home' ? 0 : maxVolume());
    } else if (event.key in steps) {
        event.preventDefault();
        setVolume(currentSettings.volume + steps[event.key]);
    }
});
volumeValue.addEventListener('input', sizeVolumeInput);
volumeValue.addEventListener('change', () => {
    const value = volumeValue.valueAsNumber;
    volumeValue.value = Number.isFinite(value) ? clampVolume(value) : currentSettings.volume;
    if (Number.isFinite(value)) setVolume(value);
    else updateVolumeUI();
});
volumeValue.addEventListener('keydown', event => {
    if (event.key === 'Enter') volumeValue.blur();
    if (event.key === 'Escape') { volumeValue.value = currentSettings.volume; volumeValue.blur(); event.stopPropagation(); }
});
$('decreaseVolume').addEventListener('click', () => setVolume(currentSettings.volume - 5));
$('increaseVolume').addEventListener('click', () => setVolume(currentSettings.volume + 5));
quickBtns.forEach(button => button.addEventListener('click', () => button.id === 'muteBtn' ? toggleMute() : setVolume(Number(button.dataset.volume))));
methodBtns.forEach(button => button.addEventListener('click', () => setVolume(currentSettings.volume, button.dataset.method)));
$('waveformEnabled').addEventListener('change', event => {
    currentSettings.nativeVolumeControl = !event.target.checked;
    sendChange('updateTabSettings', { nativeVolumeControl: currentSettings.nativeVolumeControl });
});
$('restoreAudioBtn').addEventListener('click', () => sendChange('restoreSiteAudio'));
$('reloadPageBtn').addEventListener('click', () => sendChange('reloadPage'));

// Three views share the popup: controls, media details, and settings.
const views = {
    main: { panel: 'mainPanel' },
    details: { panel: 'detailsPanel', toggle: 'detailsToggle', back: 'detailsBackBtn', open: 'Hide media details', closed: 'Show media details' },
    settings: { panel: 'settingsPanel', toggle: 'settingsToggle', back: 'backBtn', open: 'Close settings', closed: 'Open settings' }
};
let currentView = 'main';
function showView(view) {
    const previous = currentView;
    currentView = view;
    for (const [name, config] of Object.entries(views)) {
        $(config.panel).hidden = name !== view;
        if (!config.toggle) continue;
        $(config.toggle).setAttribute('aria-expanded', String(name === view));
        $(config.toggle).setAttribute('aria-label', name === view ? config.open : config.closed);
    }
    window.scrollTo(0, 0);
    // Focus the way back in a subview, or the button that opened the last one.
    (view === 'main' ? $(views[previous].toggle || 'settingsToggle') : $(views[view].back)).focus();
}
for (const name of ['details', 'settings']) {
    $(views[name].toggle).addEventListener('click', () => showView(currentView === name ? 'main' : name));
    $(views[name].back).addEventListener('click', () => showView('main'));
}

async function loadGlobalSettings() {
    try {
        const result = await browser.storage.local.get('_globalSettings');
        globalSettings = { ...globalSettings, ...result._globalSettings };
    } catch (_) { $('settingsFeedback').textContent = 'Couldn’t load saved preferences.'; }
    $('maxVolumeSelect').value = globalSettings.maxVolume;
    for (const key of ['rememberMethod', 'rememberVolume', 'persistVolume', 'accessibilityMode']) $(key).checked = globalSettings[key];
    if (!THEMES.includes(globalSettings.theme)) globalSettings.theme = 'system';
    $('themeSelect').value = globalSettings.theme;
    applyAppearance();
}

function applyAppearance() {
    // "system" leaves color-scheme to the browser; CSS light-dark() does the rest.
    document.documentElement.dataset.theme = globalSettings.theme;
    document.documentElement.dataset.accessibility = String(globalSettings.accessibilityMode);
}

function saveGlobalSettings() {
    const snapshot = { ...globalSettings };
    $('settingsFeedback').textContent = 'Saving…';
    const operation = settingsQueue.then(() => browser.storage.local.set({ _globalSettings: snapshot }));
    settingsQueue = operation.catch(() => {});
    operation.then(() => { $('settingsFeedback').textContent = 'Changes saved.'; })
        .catch(() => { $('settingsFeedback').textContent = 'Couldn’t save changes. Please try again.'; });
}

$('maxVolumeSelect').addEventListener('change', event => {
    globalSettings.maxVolume = Number(event.target.value);
    saveGlobalSettings();
    if (currentSettings.volume > maxVolume()) setVolume(maxVolume());
    else render();
});
for (const key of ['rememberMethod', 'rememberVolume', 'persistVolume', 'accessibilityMode']) {
    $(key).addEventListener('change', event => {
        globalSettings[key] = event.target.checked;
        applyAppearance();
        saveGlobalSettings();
    });
}
$('themeSelect').addEventListener('change', event => {
    globalSettings.theme = event.target.value;
    applyAppearance();
    saveGlobalSettings();
});
$('resetBtn').addEventListener('click', async () => {
    if (!confirm('Reset saved volume, control methods, and site-control preferences for every website? Your appearance and global settings will be kept.')) return;
    $('resetBtn').disabled = true;
    try {
        const all = await browser.storage.local.get(null);
        await browser.storage.local.remove(Object.keys(all).filter(key => key !== '_globalSettings'));
        $('settingsFeedback').textContent = 'Saved sites reset. Open a new tab to use the defaults.';
    } catch (_) { $('settingsFeedback').textContent = 'Couldn’t reset saved sites. Please try again.'; }
    finally { $('resetBtn').disabled = false; }
});

document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (currentView !== 'main') {
        if (event.key === 'Escape') { event.preventDefault(); showView('main'); }
        return;
    }
    // Inputs retain native arrow behavior; the slider must never receive two changes.
    const key = event.key.toLowerCase();
    if (event.target.closest('input, select, textarea, [contenteditable="true"], summary') &&
        !(event.target === volumeSlider && key === 'm')) return;
    if (currentSettings.nativeVolumeControl || !Number.isInteger(currentTabId)) return;
    if (['arrowup', 'arrowright', 'arrowdown', 'arrowleft'].includes(key)) {
        event.preventDefault();
        setVolume(currentSettings.volume + (['arrowup', 'arrowright'].includes(key) ? 5 : -5));
    } else if (key === 'm') { event.preventDefault(); toggleMute(); }
});

init();
