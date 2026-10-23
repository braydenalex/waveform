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
const COUNT_FIELDS = ['webAudioContextCount', 'html5AudioCount', 'html5VideoCount', 'mediaCount', 'playbackCount', 'controllableMediaCount'];
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
function normalizeSettings(value = {}) {
  return {
    volume: Number.isFinite(Number(value.volume)) ? Math.max(0, Math.min(10000, Math.round(Number(value.volume)))) : 100,
    method: VALID_METHODS.has(value.method) ? value.method : 'both',
    nativeVolumeControl: value.nativeVolumeControl !== false,
    persistVolume: !!value.persistVolume
  };
}
function queueTab(tabId, operation) {
  const next = (queues.get(tabId) || Promise.resolve()).then(operation);
  const settled = next.catch(() => {});
  queues.set(tabId, settled);
  settled.finally(() => { if (queues.get(tabId) === settled) queues.delete(tabId); });
  return next;
}
function storeSite(domain, update) {
  if (!domain) return Promise.resolve();
  const next = storageQueue.then(async () => {
    const stored = await browser.storage.local.get(domain);
    const settings = normalizeSettings({ ...stored[domain], ...update });
    delete settings.persistVolume;
    await browser.storage.local.set({ [domain]: settings });
  });
  storageQueue = next.catch(() => {});
  return next;
}
async function ensureTab(tabId, url) {
  let tab = tabStates.get(tabId);
  // URL visibility can temporarily disappear as activeTab access changes.
  if (!url && tab) return tab;
  const domain = getDomain(url);
  if (!tab || tab.domain !== domain) {
    const stored = await browser.storage.local.get([domain || '', '_globalSettings']);
    const global = stored._globalSettings || {};
    const saved = stored[domain] || {};
    const settings = normalizeSettings({
      volume: global.rememberVolume ? saved.volume : 100,
      method: global.rememberMethod !== false ? saved.method : 'both',
      nativeVolumeControl: saved.nativeVolumeControl,
      persistVolume: global.persistVolume
    });
    tab = { domain, settings, frames: new Map() };
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
  const loaded = controllable.filter(state => state.playbackCount > 0);
  const playback = loaded.length ? loaded : controllable;
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
    mediaCount: sum('mediaCount'), playbackCount: sum('playbackCount'), controllableMediaCount: sum('controllableMediaCount'), detectedCodecs: [...codecs.values()],
    streamType: playback.find(state => state.streamType)?.streamType || null,
    effectiveMethod: methods.size > 1 ? 'mixed' : playback[0]?.effectiveMethod || 'site',
    effectiveVolume: volumes.size === 1 ? playback[0]?.effectiveVolume ?? null : null,
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
  browser.runtime.sendMessage({ type: 'tabStateUpdate', tabId, settings: tab.settings, audioState: aggregateState(tab) }).catch(() => {});
}
async function handBack(tabId, tab, persist = true) {
  tab.settings = { ...tab.settings, nativeVolumeControl: true };
  sendSettings(tab); // Stop enforcement even if storage is unavailable.
  notify(tabId, tab);
  if (persist) await storeSite(tab.domain, { nativeVolumeControl: true });
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
  void queueTab(tabId, () => tabStates.delete(tabId));
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
      tab.settings = { ...tab.settings, persistVolume: !!global.persistVolume };
      sendSettings(tab);
      notify(tabId, tab);
    });
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
        return { tabId: active.id, domain: tab.domain, settings: tab.settings, hasRuntimeSettings: true, audioState: aggregateState(tab) };
      });
    }).catch(error => ({ error: error.message }));
  }
  if (!['updateTabSettings', 'restoreSiteAudio', 'reloadPage', 'getTabStatus'].includes(message.type) || !Number.isInteger(message.tabId)) return false;
  return queueTab(message.tabId, async () => {
    const info = await browser.tabs.get(message.tabId);
    const tab = await ensureTab(message.tabId, info.url);
    if (message.domain !== undefined && message.domain !== tab.domain) throw new Error('The tab navigated to another website. Reopen Waveform.');
    if (message.type === 'updateTabSettings') {
      const previous = tab.settings;
      tab.settings = normalizeSettings({ ...previous, ...message.settings });
      sendSettings(tab);
      notify(message.tabId, tab);
      const stored = await browser.storage.local.get('_globalSettings');
      const global = stored._globalSettings || {};
      const update = {
        volume: global.rememberVolume ? tab.settings.volume : 100,
        method: global.rememberMethod !== false ? tab.settings.method : 'both'
      };
      if (previous.nativeVolumeControl !== tab.settings.nativeVolumeControl) update.nativeVolumeControl = tab.settings.nativeVolumeControl;
      await storeSite(tab.domain, update);
    } else if (message.type === 'restoreSiteAudio' || message.type === 'reloadPage') {
      await handBack(message.tabId, tab);
      if (message.type === 'reloadPage') await browser.tabs.reload(message.tabId);
    } else {
      sendFrames(tab, { type: 'get-state' });
    }
    return { success: true, settings: tab.settings, audioState: aggregateState(tab) };
  }).catch(error => ({ success: false, error: error.message }));
});
