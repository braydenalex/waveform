// Background script - handles storage, message routing, and per-tab state

const DEFAULT_VOLUME = 100;
const DEFAULT_METHOD = 'both';

// Per-tab runtime settings (not persisted - tab IDs are temporary)
const tabSettings = new Map();

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Get runtime settings for a specific tab
function getTabSettings(tabId) {
  return tabSettings.get(tabId) || { volume: DEFAULT_VOLUME, method: DEFAULT_METHOD };
}

// Set runtime settings for a specific tab
function setTabSettings(tabId, settings) {
  tabSettings.set(tabId, settings);
}

// Get persisted settings for a domain (used for "remember" feature)
async function getDomainSettings(domain) {
  if (!domain) return { volume: DEFAULT_VOLUME, method: DEFAULT_METHOD };
  const result = await browser.storage.local.get(domain);
  return result[domain] || { volume: DEFAULT_VOLUME, method: DEFAULT_METHOD };
}

// Save persisted settings for a domain
async function saveDomainSettings(domain, settings) {
  if (!domain) return;
  await browser.storage.local.set({ [domain]: settings });
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
    const updated = { ...current, volume, method };
    setTabSettings(tabId, updated);
    sendResponse({ success: true, settings: updated });
    return false;
  }

  if (message.type === 'getSettings') {
    getDomainSettings(message.domain)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message || 'Failed to load settings' }));
    return true;
  }

  if (message.type === 'saveSettings') {
    saveDomainSettings(message.domain, message.settings)
      .then(() => {
        if (message.tabId) {
          setTabSettings(message.tabId, message.settings);
        }
        sendResponse({ success: true });
      })
      .catch(err => sendResponse({ success: false, error: err.message || 'Failed to save settings' }));
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
    setTabSettings(targetTabId, { volume, method });

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
