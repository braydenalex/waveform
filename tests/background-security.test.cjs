// Runs background.js with stubbed WebExtension APIs and sends it the kind of
// frame messages a hostile page or third-party iframe could produce.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TAB_ID = 7;
const TAB_URL = 'https://music.example/watch';

function listener() {
  const listeners = [];
  return { listeners, addListener: fn => listeners.push(fn) };
}

function loadBackground(stored = {}, session = {}) {
  const storage = { ...stored };
  const writes = [];
  const browser = {
    runtime: {
      onConnect: listener(), onMessage: listener(),
      getURL: file => `moz-extension://test/${file}`,
      sendMessage: () => Promise.resolve()
    },
    tabs: {
      onRemoved: listener(), onUpdated: listener(),
      get: async id => ({ id, url: TAB_URL }),
      query: async () => [{ id: TAB_ID, url: TAB_URL }],
      reload: async () => {}
    },
    storage: {
      onChanged: listener(),
      local: {
        get: async keys => Object.fromEntries([].concat(keys).filter(key => key in storage).map(key => [key, storage[key]])),
        set: async values => { writes.push(values); Object.assign(storage, values); },
        remove: async key => { delete storage[key]; }
      },
      session: {
        get: async key => ({ [key]: session[key] }),
        set: async values => { Object.assign(session, values); },
        remove: async key => { delete session[key]; }
      }
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  vm.runInNewContext(source, { browser, URL, Promise, Map, Set, Number, Math, Array, Object, console });
  return { browser, writes };
}

function connectFrame(browser, frameId, url, tabId = TAB_ID) {
  const messages = listener();
  const disconnect = listener();
  const port = {
    name: 'waveform-frame',
    sender: { tab: { id: tabId, url: TAB_URL }, frameId, url },
    onMessage: messages, onDisconnect: disconnect,
    sent: [], postMessage(message) { this.sent.push(message); },
    send(message) { messages.listeners.forEach(fn => fn(message)); }
  };
  browser.runtime.onConnect.listeners.forEach(fn => fn(port));
  return port;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10));
const getTabInfo = browser => browser.runtime.onMessage.listeners[0]({ type: 'getTabInfo' }, {});

test('malformed frame state cannot break or spoof the popup', async () => {
  const { browser } = loadBackground();
  const ad = connectFrame(browser, 5, 'https://ads.example/frame');
  await settle();
  ad.send({
    type: 'frameState',
    audioState: {
      ready: 'yes', mediaCount: '1e9', html5AudioCount: -4, loadedCount: 2, playingCount: 2, controllableMediaCount: 1,
      detectedCodecs: 'not-an-array', streamType: { type: 'x'.repeat(500), color: 'url(javascript:alert(1))' },
      effectiveMethod: '__proto__', effectiveVolume: 'Infinity', failureReason: '<img src=x onerror=alert(1)>',
      extra: { nested: true }
    }
  });
  await settle();
  const info = await getTabInfo(browser);
  assert.equal(info.error, undefined);
  assert.equal(info.audioState.mediaCount, 10000);
  assert.equal(info.audioState.html5AudioCount, 0);
  assert.equal(info.audioState.detectedCodecs.length, 0);
  assert.equal(info.audioState.streamType.type.length, 40);
  assert.equal(info.audioState.streamType.color, null);
  assert.equal(info.audioState.effectiveMethod, 'site');
  assert.equal(info.audioState.effectiveVolume, null);
  assert.equal(info.audioState.failureReason, null);
  assert.equal(info.audioState.ready, false);
});

test('playback counts stay separate from loaded audio and playing sources determine applied volume', async () => {
  const { browser } = loadBackground();
  const main = connectFrame(browser, 0, TAB_URL);
  const iframe = connectFrame(browser, 3, TAB_URL);
  await getTabInfo(browser);
  const report = (frame, fields) => frame.send({ type: 'frameState', audioState: {
    ready: true, mediaCount: 1, controllableMediaCount: 1, effectiveMethod: 'html5', ...fields
  } });
  report(main, { waitingCount: 1, effectiveVolume: 50 });
  let { audioState } = await getTabInfo(browser);
  assert.equal(audioState.loadedCount, 0);
  assert.equal(audioState.effectiveVolume, null);
  report(main, { loadedCount: 1, pausedCount: 1, effectiveVolume: 25 });
  report(iframe, { loadedCount: 1, playingCount: 1, effectiveVolume: 50 });
  ({ audioState } = await getTabInfo(browser));
  assert.equal(audioState.loadedCount, 2);
  assert.equal(audioState.pausedCount, 1);
  assert.equal(audioState.playingCount, 1);
  assert.equal(audioState.effectiveVolume, 50);
});

test('forgetting a site clears its saved preferences and resets only the current tab', async () => {
  const global = { rememberVolume: true, maxVolume: 300 };
  const other = { volume: 35, method: 'html5' };
  const { browser } = loadBackground({
    _globalSettings: global, 'music.example': { volume: 200, nativeVolumeControl: false }, 'video.example': other
  });
  const send = (type, tabId) => browser.runtime.onMessage.listeners[0]({ type, tabId, domain: 'music.example' }, {});
  assert.equal((await send('getTabStatus', TAB_ID + 1)).settings.volume, 200);
  const result = await send('forgetSite', TAB_ID);
  assert.equal(result.success, true);
  assert.equal(result.settings.volume, 100);
  assert.equal(result.settings.nativeVolumeControl, true);
  assert.equal((await send('getTabStatus', TAB_ID + 1)).settings.volume, 200);
  assert.equal((await send('getTabStatus', TAB_ID + 2)).settings.volume, 100);
  assert.deepEqual(await browser.storage.local.get(['_globalSettings', 'music.example', 'video.example']), {
    _globalSettings: global, 'video.example': other
  });
});

test('the mixer includes audible and muted tabs and scopes adjustments to the target tab', async () => {
  const { browser, writes } = loadBackground({ _globalSettings: { maxVolume: 200 } });
  const source = { id: TAB_ID, url: TAB_URL };
  const music = { id: TAB_ID + 1, url: 'https://other.example/', title: 'Music', audible: true };
  const muted = { id: TAB_ID + 2, index: 2, mutedInfo: { muted: true } };
  const privateTab = { id: TAB_ID + 3, audible: true, incognito: true };
  const tabs = [source, music, muted, privateTab];
  browser.tabs.query = async () => tabs;
  browser.tabs.get = async id => tabs.find(tab => tab.id === id);
  browser.tabs.update = async (id, changes) => {
    assert.equal(id, muted.id);
    muted.mutedInfo.muted = changes.muted;
  };
  const send = message => browser.runtime.onMessage.listeners[0](message, {});
  const frame = connectFrame(browser, 0, music.url, music.id);
  await send({ type: 'getTabStatus', tabId: music.id });
  frame.send({ type: 'frameState', audioState: { ready: true, mediaCount: 1, controllableMediaCount: 1 } });
  await send({ type: 'getTabStatus', tabId: music.id });

  const list = () => send({ type: 'getMixerTabs', tabId: source.id });
  const { tabs: listed } = await list();
  assert.deepEqual(Array.from(listed, tab => tab.tabId), [music.id, muted.id]);
  assert.equal(listed[0].maxVolume, 200);
  assert.equal(listed[1].maxVolume, null);
  const adjust = volume => send({ type: 'setMixerVolume', sourceTabId: source.id, tabId: music.id, domain: 'other.example', volume });
  assert.equal((await adjust(300)).settings.volume, 200);
  assert.equal(frame.sent.at(-1).settings.nativeVolumeControl, false);
  assert.equal((await getTabInfo(browser)).settings.nativeVolumeControl, true);
  assert.equal(writes.length, 0);
  await adjust(0);
  music.audible = false;
  assert.equal((await list()).tabs[0].volume, 0);
  const nativeMute = await send({ type: 'setMixerMuted', sourceTabId: source.id, tabId: muted.id, domain: null, muted: false });
  assert.equal(nativeMute.success, true);
  assert.equal(muted.mutedInfo.muted, false);
  music.url = 'https://different.example/';
  assert.equal((await adjust(50)).success, false);
  const privateMute = await send({ type: 'setMixerMuted', sourceTabId: source.id, tabId: privateTab.id, domain: null, muted: true });
  assert.equal(privateMute.success, false);
});

test('codec lists are capped and filtered', async () => {
  const { browser } = loadBackground();
  const frame = connectFrame(browser, 0, TAB_URL);
  await settle();
  const codecs = Array.from({ length: 500 }, (_, i) => ({ type: i % 2 ? 'audio' : 'video', codec: `C${i}`, color: '#123456' }));
  codecs.unshift({ type: 'evil', codec: 'X' }, null, 'string');
  frame.send({ type: 'frameState', audioState: { ready: true, mediaCount: 1, detectedCodecs: codecs } });
  await settle();
  const info = await getTabInfo(browser);
  assert.ok(info.audioState.detectedCodecs.length <= 20);
  assert.ok(info.audioState.detectedCodecs.every(codec => ['audio', 'video'].includes(codec.type)));
});

test('a third-party iframe cannot save site controls for the top site', async () => {
  const { browser, writes } = loadBackground({ 'music.example': { nativeVolumeControl: false } });
  const ad = connectFrame(browser, 5, 'https://ads.example/frame');
  await settle();
  ad.send({ type: 'nativeVolumeTouched' });
  await settle();
  assert.equal(writes.length, 0);
  const info = await getTabInfo(browser);
  assert.equal(info.settings.nativeVolumeControl, true, 'control still returns to the site for this tab');
});

test('the top frame and same-origin frames still save site controls', async () => {
  for (const [frameId, url] of [[0, TAB_URL], [3, 'https://music.example/embed']]) {
    const { browser, writes } = loadBackground({ 'music.example': { nativeVolumeControl: false } });
    const frame = connectFrame(browser, frameId, url);
    await settle();
    frame.send({ type: 'nativeVolumeTouched' });
    await settle();
    assert.equal(writes.at(-1)?.['music.example']?.nativeVolumeControl, true, `frame ${frameId}`);
  }
});

test('the maximum caps saved, live, and newly requested levels in every tab', async () => {
  const global = { rememberVolume: true, maxVolume: 500 };
  const { browser } = loadBackground({
    _globalSettings: global,
    'music.example': { volume: 800, nativeVolumeControl: false }
  });
  for (const tabId of [TAB_ID, TAB_ID + 1]) {
    const frame = connectFrame(browser, 0, TAB_URL, tabId);
    await browser.runtime.onMessage.listeners[0]({ type: 'getTabStatus', tabId }, {});
    assert.equal(frame.sent.find(message => message.type === 'settings').settings.volume, 500);
  }

  const newValue = { ...global, maxVolume: 300 };
  await browser.storage.local.set({ _globalSettings: newValue });
  browser.storage.onChanged.listeners[0]({ _globalSettings: { newValue } }, 'local');
  for (const tabId of [TAB_ID, TAB_ID + 1]) {
    const status = await browser.runtime.onMessage.listeners[0]({ type: 'getTabStatus', tabId }, {});
    assert.equal(status.settings.volume, 300);
    assert.equal(status.settings.maxVolume, 300);
    const update = await browser.runtime.onMessage.listeners[0]({ type: 'updateTabSettings', tabId, settings: { volume: 400 } }, {});
    assert.equal(update.settings.volume, 300);
  }
  const standard = await browser.runtime.onMessage.listeners[0]({ type: 'updateTabSettings', tabId: TAB_ID, settings: { method: 'html5' } }, {});
  assert.equal(standard.settings.volume, 100);
});

test('muting keeps the last audible level in the same tab across popup opens', async () => {
  const session = {};
  const { browser, writes } = loadBackground({ _globalSettings: { rememberVolume: true } }, session);
  const update = settings => browser.runtime.onMessage.listeners[0]({ type: 'updateTabSettings', tabId: TAB_ID, settings }, {});
  await update({ volume: 35 });
  await update({ volume: 0 });
  assert.equal((await getTabInfo(browser)).settings.lastAudibleVolume, 35);

  // A slider move immediately followed by mute may be sent as one update.
  await update({ volume: 0, lastAudibleVolume: 275 });
  assert.equal((await getTabInfo(browser)).settings.lastAudibleVolume, 275);
  const other = await browser.runtime.onMessage.listeners[0]({ type: 'getTabStatus', tabId: TAB_ID + 1 }, {});
  assert.equal(other.settings.volume, 0);
  assert.equal(other.settings.lastAudibleVolume, 100);
  assert.equal(writes.at(-1)['music.example'].lastAudibleVolume, undefined);

  browser.storage.onChanged.listeners[0]({ _globalSettings: { newValue: { maxVolume: 200 } } }, 'local');
  const muted = await getTabInfo(browser);
  assert.equal(muted.settings.volume, 0);
  assert.equal(muted.settings.lastAudibleVolume, 200);

  const restarted = loadBackground({}, session).browser;
  const reopened = await getTabInfo(restarted);
  assert.equal(reopened.settings.volume, 0);
  assert.equal(reopened.settings.lastAudibleVolume, 200);
  restarted.tabs.onRemoved.listeners[0](TAB_ID);
  assert.equal((await getTabInfo(restarted)).settings.lastAudibleVolume, 100);
});
