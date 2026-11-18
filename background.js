// One authority for runtime settings, persistence, and per-frame status.
const VALID_METHODS = new Set(['webaudio', 'html5', 'both']);
const tabStates = new Map();
const queues = new Map();
let storageQueue = Promise.resolve();

// Frame state is written by code running in web pages (including third-party
// iframes), so only known fields with bounded, typed values are kept.
const FAILURE_REASONS = new Set([
  'injector-unavailable', 'interaction-required', 'resume-failed', 'site-context-suspended',
  'no-audio-track', 'protected-media', 'cors-unverified', 'media-not-ready', 'web-audio-unavailable',
  'stream-unverified', 'source-unverified', 'routing-failed', 'context-closed', 'graph-unavailable'
]);
const REPORTED_METHODS = new Set(['site', 'html5', 'webaudio', 'mixed']);
const BOOLEAN_FIELDS = ['ready', 'hasWebAudio', 'hasHTML5Audio', 'hasHTML5Video', 'boostAvailable', 'reloadRequired'];
const COUNT_FIELDS = ['webAudioContextCount', 'html5AudioCount', 'html5VideoCount', 'mediaCount', 'loadedCount',
  'playingCount', 'pausedCount', 'waitingCount', 'controllableMediaCount'];
const MAX_CODECS = 20;

function shortText(value, max = 40) {
  return typeof value === 'string' && value ? value.slice(0, max) : null;
}
function color(value) {
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? value : null;
}
function boundedNumber(value, max) {
  const number = Number(value);
  return value !== null && value !== '' && Number.isFinite(number) ? Math.max(0, Math.min(max, number)) : null;
}
function sanitizeAudioState(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const state = {};
  for (const key of BOOLEAN_FIELDS) state[key] = input[key] === true;
  for (const key of COUNT_FIELDS) state[key] = Math.round(boundedNumber(input[key], 10000) ?? 0);
  state.effectiveMethod = REPORTED_METHODS.has(input.effectiveMethod) ? input.effectiveMethod : 'site';
  state.effectiveVolume = boundedNumber(input.effectiveVolume, 100000);
  state.requestedVolume = boundedNumber(input.requestedVolume, 100000);
  state.failureReason = FAILURE_REASONS.has(input.failureReason) ? input.failureReason : null;
  const stream = input.streamType && typeof input.streamType === 'object' ? input.streamType : null;
  state.streamType = stream && shortText(stream.type) ? { type: shortText(stream.type), color: color(stream.color) } : null;
  state.detectedCodecs = (Array.isArray(input.detectedCodecs) ? input.detectedCodecs.slice(0, MAX_CODECS) : [])
    .filter(codec => codec && typeof codec === 'object' && ['audio', 'video'].includes(codec.type) && shortText(codec.codec))
    .map(codec => ({ type: codec.type, codec: shortText(codec.codec), color: color(codec.color) }));
  return state;
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return null; }
}
function getOrigin(url) {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch { return null; }
}
function normalizeSettings(value = {}, limit = 10000) {
  return {
    volume: Math.round(boundedNumber(value.volume, limit) ?? 100),
    method: VALID_METHODS.has(value.method) ? value.method : 'both',
    nativeVolumeControl: value.nativeVolumeControl !== false,
    persistVolume: !!value.persistVolume
  };
}
function applyTabSettings(tab, global, update = {}) {
  const next = { ...tab.settings, ...update, persistVolume: global.persistVolume };
  const maximum = Math.round(boundedNumber(global.maxVolume, 10000) ?? 1000);
  tab.maxVolume = Math.max(200, maximum);
  const limit = next.method === 'html5' ? 100 : tab.maxVolume;
  tab.settings = normalizeSettings(next, limit);
  // A coalesced volume update can go straight to zero without sending the
  // last audible slider position. The popup supplies it with that update.
  const previous = update.volume === 0 ? boundedNumber(update.lastAudibleVolume, limit) : null;
  const restoreVolume = Math.round(previous || tab.lastAudibleVolume || 100);
  tab.lastAudibleVolume = tab.settings.volume || Math.max(1, Math.min(limit, restoreVolume));
}
function popupSettings(tab) {
  return { ...tab.settings, maxVolume: tab.maxVolume, lastAudibleVolume: tab.lastAudibleVolume };
}
function saveTab(tabId, tab) {
  const { domain, settings, lastAudibleVolume } = tab;
  return browser.storage.session.set({ [tabId]: { domain, settings, lastAudibleVolume } });
}
function queueTab(tabId, operation) {
  const next = (queues.get(tabId) || Promise.resolve()).then(operation);
  const settled = next.catch(() => {});
  queues.set(tabId, settled);
  settled.finally(() => { if (queues.get(tabId) === settled) queues.delete(tabId); });
  return next;
}
function queueSiteStorage(operation) {
  const next = storageQueue.then(operation);
  storageQueue = next.catch(() => {});
  return next;
}
function storeSite(domain, update) {
  if (!domain) return Promise.resolve();
  return queueSiteStorage(async () => {
    const stored = await browser.storage.local.get(domain);
    const settings = normalizeSettings({ ...stored[domain], ...update });
    delete settings.persistVolume;
    await browser.storage.local.set({ [domain]: settings });
  });
}
async function ensureTab(tabId, url) {
  let tab = tabStates.get(tabId);
  // URL visibility can temporarily disappear as activeTab access changes.
  if (!url && tab) return tab;
  const domain = getDomain(url);
  if (!tab || tab.domain !== domain) {
    const key = String(tabId);
    const [stored, session] = await Promise.all([
      browser.storage.local.get([domain || '', '_globalSettings']),
      browser.storage.session.get(key)
    ]);
    const global = stored._globalSettings || {};
    const saved = stored[domain] || {};
    // The event page can go idle while the tab stays open.
    const live = session[key]?.domain === domain ? session[key] : null;
    if (url && session[key] && !live) await browser.storage.session.remove(key);
    tab = { domain, frames: new Map(), lastAudibleVolume: live?.lastAudibleVolume };
    applyTabSettings(tab, global, {
      volume: global.rememberVolume ? saved.volume : 100,
      method: global.rememberMethod !== false ? saved.method : 'both',
      nativeVolumeControl: saved.nativeVolumeControl,
      ...live?.settings
    });
    tabStates.set(tabId, tab);
  }
  return tab;
}
function sendFrames(tab, message) {
  for (const frame of tab.frames.values()) {
    try { frame.port.postMessage(message); } catch { /* Disconnected frame. */ }
  }
}
function sendSettings(tab) {
  sendFrames(tab, { type: 'settings', settings: tab.settings });
}
function aggregateState(tab) {
  const frames = [...(tab?.frames.values() || [])].map(frame => frame.state).filter(Boolean);
  const media = frames.filter(state => state.mediaCount > 0);
  const controllable = media.filter(state => state.controllableMediaCount !== 0);
  const loaded = controllable.filter(state => state.loadedCount > 0);
  const playing = loaded.filter(state => state.playingCount > 0);
  const playback = playing.length ? playing : loaded.length ? loaded : controllable;
  const states = playback.length ? playback : frames;
  const sum = key => frames.reduce((total, state) => total + (Number(state[key]) || 0), 0);
  const methods = new Set(playback.map(state => state.effectiveMethod));
  const volumes = new Set(playback.map(state => state.effectiveVolume));
  const codecs = new Map();
  frames.forEach(state => (state.detectedCodecs || []).forEach(codec => codecs.set(codec.codec, codec)));
  return {
    ready: frames.length > 0 && frames.every(state => state.ready),
    hasWebAudio: frames.some(state => state.hasWebAudio),
    hasHTML5Audio: frames.some(state => state.hasHTML5Audio),
    hasHTML5Video: frames.some(state => state.hasHTML5Video),
    webAudioContextCount: sum('webAudioContextCount'), html5AudioCount: sum('html5AudioCount'), html5VideoCount: sum('html5VideoCount'),
    mediaCount: sum('mediaCount'), loadedCount: sum('loadedCount'), playingCount: sum('playingCount'),
    pausedCount: sum('pausedCount'), waitingCount: sum('waitingCount'), controllableMediaCount: sum('controllableMediaCount'),
    detectedCodecs: [...codecs.values()],
    streamType: playback.find(state => state.streamType)?.streamType || null,
    effectiveMethod: methods.size > 1 ? 'mixed' : playback[0]?.effectiveMethod || 'site',
    effectiveVolume: loaded.length && volumes.size === 1 ? playback[0].effectiveVolume : null,
    requestedVolume: tab?.settings.volume ?? 100,
    boostAvailable: playback.length > 0 && playback.every(state => state.boostAvailable),
    reloadRequired: frames.some(state => state.reloadRequired),
    failureReason: frames.find(state => state.reloadRequired)?.failureReason ||
      frames.find(state => !state.ready)?.failureReason ||
      states.find(state => ['interaction-required', 'resume-failed'].includes(state.failureReason))?.failureReason ||
      states.find(state => state.failureReason)?.failureReason || null
  };
}
function notify(tabId, tab) {
  browser.runtime.sendMessage({ type: 'tabStateUpdate', tabId, settings: popupSettings(tab), audioState: aggregateState(tab) }).catch(() => {});
}
function mixerTab(info) {
  const tab = tabStates.get(info.id);
  const domain = info.url ? getDomain(info.url) : tab?.domain ?? null;
  const canAdjust = !!tab && tab.domain === domain && [...tab.frames.values()].some(({ state }) =>
    state?.ready && state.controllableMediaCount > 0 && !state.reloadRequired &&
    (tab.settings.method !== 'html5' || state.hasHTML5Audio || state.hasHTML5Video));
  const settings = canAdjust ? tab.settings : null;
  return {
    tabId: info.id, domain,
    title: shortText(info.title, 200) || domain || `Tab ${info.index + 1}`,
    audible: !!info.audible, muted: !!info.mutedInfo?.muted,
    volume: settings?.nativeVolumeControl === false ? settings.volume : null,
    maxVolume: settings ? (settings.method === 'html5' ? 100 : tab.maxVolume) : null
  };
}

async function getMixerTabs(sourceTabId) {
  const source = await browser.tabs.get(sourceTabId);
  const tabs = await browser.tabs.query({});
  return { success: true, tabs: tabs.filter(info => Number.isInteger(info.id) && !!info.incognito === !!source.incognito)
    .map(mixerTab).filter(tab => tab.audible || tab.muted || tab.volume === 0) };
}
async function handBack(tabId, tab, persist = true) {
  tab.settings = { ...tab.settings, nativeVolumeControl: true };
  sendSettings(tab); // Stop enforcement even if storage is unavailable.
  notify(tabId, tab);
  await Promise.all([
    saveTab(tabId, tab),
    persist && storeSite(tab.domain, { nativeVolumeControl: true })
  ]);
}

browser.runtime.onConnect.addListener(port => {
  if (port.name !== 'waveform-frame' || !Number.isInteger(port.sender?.tab?.id)) return;
  const tabId = port.sender.tab.id;
  const frameId = port.sender.frameId;
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    void queueTab(tabId, () => {
      const tab = tabStates.get(tabId);
      if (tab?.frames.get(frameId)?.port === port) {
        tab.frames.delete(frameId);
        notify(tabId, tab);
      }
    });
  });
  void queueTab(tabId, async () => {
    if (disconnected) return;
    const current = await browser.tabs.get(tabId);
    const tabUrl = current.url || port.sender.tab.url;
    const tab = await ensureTab(tabId, tabUrl);
    if (disconnected) return;
    // Only the top document, or a frame from the same origin, may change the
    // saved preference for the site shown in the address bar.
    const frameOrigin = getOrigin(port.sender.url);
    const sameSite = frameId === 0 || (!!frameOrigin && frameOrigin === getOrigin(tabUrl));
    tab.frames.set(frameId, { port, sameSite, state: sanitizeAudioState({}) });
    port.postMessage({ type: 'settings', settings: tab.settings });
    port.postMessage({ type: 'get-state' });
  }).catch(() => {});
  port.onMessage.addListener(message => {
    void queueTab(tabId, async () => {
      const tab = tabStates.get(tabId);
      const frame = tab?.frames.get(frameId);
      if (disconnected || frame?.port !== port || !message || typeof message !== 'object') return;
      if (message.type === 'frameState' && message.audioState && typeof message.audioState === 'object') {
        frame.state = sanitizeAudioState(message.audioState);
        notify(tabId, tab);
      } else if (message.type === 'nativeVolumeTouched') {
        // Third-party frames still hand control back for this tab, but are not saved.
        await handBack(tabId, tab, frame.sameSite);
      }
    }).catch(() => {});
  });
});

browser.tabs.onRemoved.addListener(tabId => {
  void queueTab(tabId, () => {
    tabStates.delete(tabId);
    return browser.storage.session.remove(String(tabId));
  }).catch(() => {});
});
browser.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url && change.status !== 'loading') return;
  void queueTab(tabId, async () => {
    const existing = tabStates.get(tabId);
    if (!existing) return;
    const current = await browser.tabs.get(tabId);
    const tab = await ensureTab(tabId, current.url);
    // Same-domain reloads retain preferences, but never display old document state.
    if (change.status === 'loading') {
      for (const frame of tab.frames.values()) frame.state = null;
    }
    sendSettings(tab);
    sendFrames(tab, { type: 'get-state' });
    notify(tabId, tab);
  }).catch(() => {});
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes._globalSettings) return;
  const global = changes._globalSettings.newValue || {};
  for (const tabId of tabStates.keys()) {
    void queueTab(tabId, () => {
      const tab = tabStates.get(tabId);
      if (!tab) return;
      const previousVolume = tab.settings.volume;
      const previousRestoreVolume = tab.lastAudibleVolume;
      applyTabSettings(tab, global);
      sendSettings(tab);
      notify(tabId, tab);
      if (tab.settings.volume !== previousVolume || tab.lastAudibleVolume !== previousRestoreVolume) return saveTab(tabId, tab);
    }).catch(() => {});
  }
});

browser.runtime.onMessage.addListener((message, sender) => {
  // Extension pages may also run in a tab (for accessibility or debugging).
  // Page content must use its registered frame port.
  if (!message || (sender.tab && !sender.url?.startsWith(browser.runtime.getURL('')))) return false;
  if (message.type === 'getTabInfo') {
    return browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (!tabs[0]) return { error: 'No active tab' };
      const active = tabs[0];
      return queueTab(active.id, async () => {
        const tab = await ensureTab(active.id, active.url);
        sendFrames(tab, { type: 'get-state' });
        return { tabId: active.id, domain: tab.domain, muted: !!active.mutedInfo?.muted, audible: !!active.audible,
          settings: popupSettings(tab), hasRuntimeSettings: true, audioState: aggregateState(tab) };
      });
    }).catch(error => ({ error: error.message }));
  }
  if (!Number.isInteger(message.tabId)) return false;
  if (message.type === 'getMixerTabs') return getMixerTabs(message.tabId).catch(error => ({ success: false, error: error.message }));
  const mixerAction = ['setMixerVolume', 'setMixerMuted', 'focusMixerTab'].includes(message.type);
  if (!mixerAction && !['updateTabSettings', 'restoreSiteAudio', 'reloadPage', 'getTabStatus', 'forgetSite'].includes(message.type)) return false;
  return queueTab(message.tabId, async () => {
    const info = await browser.tabs.get(message.tabId);
    if (mixerAction) {
      const source = await browser.tabs.get(message.sourceTabId);
      const target = mixerTab(info);
      if (!!source.incognito !== !!info.incognito || message.domain !== target.domain) {
        throw new Error('This tab changed. Open the mixer again.');
      }
      if (message.type === 'setMixerMuted') {
        await browser.tabs.update(info.id, { muted: message.muted === true });
        return { success: true };
      }
      if (message.type === 'focusMixerTab') {
        await browser.tabs.update(info.id, { active: true });
        if (info.windowId !== source.windowId) await browser.windows.update(info.windowId, { focused: true });
        return { success: true };
      }
      if (target.maxVolume === null) throw new Error('Waveform can’t adjust this player. You can still mute its tab.');
    }
    const tab = await ensureTab(message.tabId, info.url);
    if (message.domain !== undefined && message.domain !== tab.domain) throw new Error('The tab navigated to another website. Reopen Waveform.');
    if (message.type === 'updateTabSettings' || message.type === 'setMixerVolume' || message.type === 'forgetSite') {
      const previous = tab.settings;
      const stored = await browser.storage.local.get('_globalSettings');
      const global = stored._globalSettings || {};
      let settings = message.settings;
      if (message.type === 'forgetSite') {
        if (!tab.domain) throw new Error('Open a website to forget its settings.');
        await queueSiteStorage(() => browser.storage.local.remove(tab.domain));
        settings = { volume: 100, method: 'both', nativeVolumeControl: true };
      } else if (message.type === 'setMixerVolume') {
        if (!Number.isFinite(message.volume)) throw new Error('Enter a valid volume.');
        settings = { volume: message.volume, nativeVolumeControl: false };
      }
      applyTabSettings(tab, global, settings);
      sendSettings(tab);
      notify(message.tabId, tab);
      const saved = saveTab(message.tabId, tab);
      if (message.type === 'updateTabSettings') {
        const update = {
          volume: global.rememberVolume ? tab.settings.volume : 100,
          method: global.rememberMethod !== false ? tab.settings.method : 'both'
        };
        if (previous.nativeVolumeControl !== tab.settings.nativeVolumeControl) update.nativeVolumeControl = tab.settings.nativeVolumeControl;
        await Promise.all([saved, storeSite(tab.domain, update)]);
      } else {
        await saved;
      }
    } else if (message.type === 'restoreSiteAudio' || message.type === 'reloadPage') {
      await handBack(message.tabId, tab);
      if (message.type === 'reloadPage') await browser.tabs.reload(message.tabId);
    } else {
      sendFrames(tab, { type: 'get-state' });
    }
    return { success: true, settings: popupSettings(tab), audioState: aggregateState(tab) };
  }).catch(error => ({ success: false, error: error.message }));
});
