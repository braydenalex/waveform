// Background script - handles storage, message routing, and per-tab state

const DEFAULT_VOLUME = 100;
const DEFAULT_METHOD = 'both';
const DEFAULT_NATIVE_VOLUME_CONTROL = true;
const VALID_METHODS = new Set(['webaudio', 'html5', 'both']);

// Per-tab runtime settings (not persisted - tab IDs are temporary)
const tabSettings = new Map();

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function normalizeSettings(settings = {}) {
  const rawVolume = Number(settings.volume);
  const volume = Number.isFinite(rawVolume) ? Math.round(rawVolume) : DEFAULT_VOLUME;
  const method = VALID_METHODS.has(settings.method) ? settings.method : DEFAULT_METHOD;
  const hasNativeVolumeControl = Object.prototype.hasOwnProperty.call(settings, 'nativeVolumeControl');

  return {
    volume: Math.max(0, volume),
    method,
    nativeVolumeControl: hasNativeVolumeControl
      ? !!settings.nativeVolumeControl
      : DEFAULT_NATIVE_VOLUME_CONTROL
  };
}

function mergeSettings(base = {}, overrides = {}) {
  return normalizeSettings({ ...base, ...overrides });
}

// Get runtime settings for a specific tab
function getTabSettings(tabId) {
  return normalizeSettings(tabSettings.get(tabId));
}

// Set runtime settings for a specific tab
function setTabSettings(tabId, settings) {
  tabSettings.set(tabId, normalizeSettings(settings));
}

// Get persisted settings for a domain (used for "remember" feature)
async function getDomainSettings(domain) {
  if (!domain) {
    return {
      volume: DEFAULT_VOLUME,
      method: DEFAULT_METHOD,
      nativeVolumeControl: DEFAULT_NATIVE_VOLUME_CONTROL
    };
  }
  const result = await browser.storage.local.get(domain);
  return mergeSettings(
    {
      volume: DEFAULT_VOLUME,
      method: DEFAULT_METHOD,
      nativeVolumeControl: DEFAULT_NATIVE_VOLUME_CONTROL
    },
    result[domain] || {}
  );
}

// Save persisted settings for a domain
async function saveDomainSettings(domain, settings) {
  if (!domain) return;
  await browser.storage.local.set({ [domain]: normalizeSettings(settings) });
}

// Clean up when tabs are closed
browser.tabs.onRemoved.addListener((tabId) => {
  tabSettings.delete(tabId);
});

// Handle messages from popup and content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return false;
  }

  if (message.type === 'getTabInfo') {
    (async () => {
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) {
          const tabId = tabs[0].id;
          const domain = getDomain(tabs[0].url);

          let settings = tabSettings.get(tabId);
          const hasRuntimeSettings = !!settings;

          if (!settings) {
            settings = await getDomainSettings(domain);
            tabSettings.set(tabId, { ...settings });
          } else {
            settings = normalizeSettings(settings);
            tabSettings.set(tabId, settings);
          }

          sendResponse({
            tabId: tabId,
            domain: domain,
            settings: settings,
            hasRuntimeSettings: hasRuntimeSettings
          });
        } else {
          sendResponse({ error: 'No active tab' });
        }
      } catch (err) {
        sendResponse({ error: err.message || 'Failed to get tab info' });
      }
    })();
    return true;
  }

  if (message.type === 'setTabVolume') {
    const { tabId, volume, method } = message;
    const current = getTabSettings(tabId);
    const updated = mergeSettings(current, { volume, method });
    setTabSettings(tabId, updated);
    sendResponse({ success: true, settings: updated });
    return false;
  }

  if (message.type === 'setNativeVolumeControl') {
    (async () => {
      try {
        const targetTabId = Number.isInteger(message.tabId) ? message.tabId : sender?.tab?.id;
        if (!Number.isInteger(targetTabId)) {
          sendResponse({ success: false, error: 'Missing tab id' });
          return;
        }

        let domain = message.domain || getDomain(sender?.tab?.url);
        if (!domain) {
          try {
            const tab = await browser.tabs.get(targetTabId);
            domain = getDomain(tab.url);
          } catch {
            domain = null;
          }
        }

        const enabled = !!message.enabled;
        const current = getTabSettings(targetTabId);
        const updated = mergeSettings(current, { nativeVolumeControl: enabled });
        setTabSettings(targetTabId, updated);

        if (message.persist !== false && domain) {
          const domainSettings = await getDomainSettings(domain);
          const mergedDomainSettings = mergeSettings(domainSettings, { nativeVolumeControl: enabled });
          await saveDomainSettings(domain, mergedDomainSettings);
        }

        browser.runtime.sendMessage({
          type: 'nativeVolumeControlChanged',
          tabId: targetTabId,
          domain,
          nativeVolumeControl: enabled,
          source: message.source || 'popup'
        }).catch(() => {
          // Popup may not be open.
        });

        sendResponse({ success: true, settings: updated, domain });
      } catch (err) {
        sendResponse({ success: false, error: err.message || 'Failed to set native volume control' });
      }
    })();
    return true;
  }

  if (message.type === 'nativeVolumeTouched') {
    (async () => {
      try {
        const tabId = sender?.tab?.id;
        if (!Number.isInteger(tabId)) {
          sendResponse({ success: false, error: 'No sender tab id' });
          return;
        }

        const domain = getDomain(sender?.tab?.url) || message.domain || null;
        const current = getTabSettings(tabId);
        if (current.nativeVolumeControl) {
          sendResponse({ success: true, changed: false, settings: current, domain });
          return;
        }

        const updated = mergeSettings(current, { nativeVolumeControl: true });
        setTabSettings(tabId, updated);

        if (domain) {
          const domainSettings = await getDomainSettings(domain);
          const mergedDomainSettings = mergeSettings(domainSettings, { nativeVolumeControl: true });
          await saveDomainSettings(domain, mergedDomainSettings);
        }

        browser.runtime.sendMessage({
          type: 'nativeVolumeControlChanged',
          tabId,
          domain,
          nativeVolumeControl: true,
          source: 'auto-detected'
        }).catch(() => {
          // Popup may not be open.
        });

        sendResponse({ success: true, changed: true, settings: updated, domain });
      } catch (err) {
        sendResponse({ success: false, error: err.message || 'Failed to apply native volume auto-toggle' });
      }
    })();
    return true;
  }

  if (message.type === 'getTabSettingsForSender') {
    (async () => {
      try {
        const tabId = sender?.tab?.id;
        const domain = getDomain(sender?.tab?.url);
        if (!Number.isInteger(tabId)) {
          sendResponse({
            tabId: null,
            domain: null,
            settings: {
              volume: DEFAULT_VOLUME,
              method: DEFAULT_METHOD,
              nativeVolumeControl: DEFAULT_NATIVE_VOLUME_CONTROL
            },
            hasRuntimeSettings: false
          });
          return;
        }

        const hasRuntimeSettings = tabSettings.has(tabId);
        let settings = hasRuntimeSettings
          ? getTabSettings(tabId)
          : await getDomainSettings(domain);

        if (!hasRuntimeSettings) {
          setTabSettings(tabId, settings);
        }

        sendResponse({
          tabId,
          domain,
          settings: normalizeSettings(settings),
          hasRuntimeSettings
        });
      } catch (err) {
        sendResponse({ error: err.message || 'Failed to get sender tab settings' });
      }
    })();
    return true;
  }

  if (message.type === 'getSettings') {
    getDomainSettings(message.domain)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message || 'Failed to load settings' }));
    return true;
  }

  if (message.type === 'saveSettings') {
    (async () => {
      try {
        const existing = await getDomainSettings(message.domain);
        const mergedDomainSettings = mergeSettings(existing, message.settings || {});
        await saveDomainSettings(message.domain, mergedDomainSettings);

        if (message.tabId) {
          const runtimeSettings = getTabSettings(message.tabId);
          setTabSettings(message.tabId, mergeSettings(runtimeSettings, message.settings || {}));
        }

        sendResponse({ success: true, settings: mergedDomainSettings });
      } catch (err) {
        sendResponse({ success: false, error: err.message || 'Failed to save settings' });
      }
    })();
    return true;
  }

  // Get all tabs with audio for cross-tab management
  if (message.type === 'getAllAudioTabs') {
    browser.tabs.query({})
      .then(tabs => {
        const audioTabs = [];
        for (const tab of tabs) {
          if (tab.audible || tabSettings.has(tab.id)) {
            const domain = getDomain(tab.url);
            audioTabs.push({
              tabId: tab.id,
              title: tab.title,
              domain: domain,
              audible: tab.audible,
              settings: getTabSettings(tab.id),
              favIconUrl: tab.favIconUrl
            });
          }
        }
        sendResponse({ tabs: audioTabs });
      })
      .catch(err => sendResponse({ tabs: [], error: err.message || 'Failed to query tabs' }));
    return true;
  }

  // Set volume for a specific tab (cross-tab control)
  if (message.type === 'setRemoteTabVolume') {
    const { targetTabId, volume, method } = message;
    const current = getTabSettings(targetTabId);
    const updated = mergeSettings(current, { volume, method });
    setTabSettings(targetTabId, updated);

    // Send to the target tab's content script
    browser.tabs.sendMessage(targetTabId, {
      type: 'setVolume',
      volume: volume,
      method: method
    }).then(() => {
      sendResponse({ success: true });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  return false;
});

console.log('[Waveform] Background script loaded');
