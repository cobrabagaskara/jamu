// ============================================================
// Jamu Loader — Content Script
// Lightweight relay: notifies background of page load,
// can also receive commands from page if needed.
// ============================================================

(function () {
  "use strict";

  // Signal to background that this page is ready for injection
  // Background handles the actual scripting.executeScript calls.
  // This content script exists mainly as a communication bridge
  // and to ensure the extension is active on the page.

  chrome.runtime.sendMessage({
    type: "PAGE_READY",
    url: window.location.href,
  }).catch(() => {
    // Service worker may be sleeping — background.js handles tab events directly
  });

  // Listen for messages from background (future use: hot-reload, etc.)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "PING") {
      return true;
    }
  });
})();
