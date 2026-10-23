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

function loadBackground(stored = {}) {
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
      get: async () => ({ id: TAB_ID, url: TAB_URL }),
      query: async () => [{ id: TAB_ID, url: TAB_URL }],
      reload: async () => {}
    },
    storage: {
      onChanged: listener(),
      local: {
        get: async keys => Object.fromEntries([].concat(keys).filter(key => key in storage).map(key => [key, storage[key]])),
        set: async values => { writes.push(values); Object.assign(storage, values); }
      }
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  vm.runInNewContext(source, { browser, URL, Promise, Map, Set, Number, Math, Array, Object, console });
  return { browser, writes };
}

function connectFrame(browser, frameId, url) {
  const messages = listener();
  const disconnect = listener();
  const port = {
    name: 'waveform-frame',
    sender: { tab: { id: TAB_ID, url: TAB_URL }, frameId, url },
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
      ready: 'yes', mediaCount: '1e9', html5AudioCount: -4, playbackCount: 2, controllableMediaCount: 1,
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
