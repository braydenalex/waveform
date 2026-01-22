// Background script - handles storage and message routing

// Default settings
const DEFAULT_VOLUME = 100;
const DEFAULT_METHOD = 'both'; // 'webaudio', 'html5', or 'both'

// Get domain from URL
function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Get settings for a domain
async function getSettings(domain) {
  if (!domain) return { volume: DEFAULT_VOLUME, method: DEFAULT_METHOD };

  const result = await browser.storage.local.get(domain);
  return result[domain] || { volume: DEFAULT_VOLUME, method: DEFAULT_METHOD };
}

// Save settings for a domain
async function saveSettings(domain, settings) {
  if (!domain) return;
  await browser.storage.local.set({ [domain]: settings });
}

// Handle messages from popup and content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getSettings') {
    getSettings(message.domain).then(sendResponse);
    return true;
  }

  if (message.type === 'saveSettings') {
    saveSettings(message.domain, message.settings).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.type === 'getTabInfo') {
    browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]) {
        const domain = getDomain(tabs[0].url);
        getSettings(domain).then(settings => {
          sendResponse({
            tabId: tabs[0].id,
            domain: domain,
            settings: settings
          });
        });
      } else {
        sendResponse({ error: 'No active tab' });
      }
    });
    return true;
  }
});

console.log('Per-Tab Volume Control background script loaded');
