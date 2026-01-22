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
  if (message.type === 'getTabInfo') {
    browser.tabs.query({ active: true, currentWindow: true }).then(async tabs => {
      if (tabs[0]) {
        const tabId = tabs[0].id;
        const domain = getDomain(tabs[0].url);

        // Check if we have runtime settings for this tab
        let settings = tabSettings.get(tabId);

        // If no runtime settings, try to load from domain storage
        if (!settings) {
          settings = await getDomainSettings(domain);
          // Initialize tab with domain settings
          tabSettings.set(tabId, { ...settings });
        }

        sendResponse({
          tabId: tabId,
          domain: domain,
          settings: settings
        });
      } else {
        sendResponse({ error: 'No active tab' });
      }
    });
    return true;
  }

  if (message.type === 'setTabVolume') {
    const { tabId, volume, method } = message;
    const current = getTabSettings(tabId);
    const updated = { ...current, volume, method };
    setTabSettings(tabId, updated);
    sendResponse({ success: true, settings: updated });
    return true;
  }

  if (message.type === 'getSettings') {
    getDomainSettings(message.domain).then(sendResponse);
    return true;
  }

  if (message.type === 'saveSettings') {
    // Save to domain storage AND update tab settings
    saveDomainSettings(message.domain, message.settings).then(() => {
      if (message.tabId) {
        setTabSettings(message.tabId, message.settings);
      }
      sendResponse({ success: true });
    });
    return true;
  }

  // Get all tabs with audio for cross-tab management
  if (message.type === 'getAllAudioTabs') {
    browser.tabs.query({}).then(async tabs => {
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
    });
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
});

console.log('[Waveform] Background script loaded');
