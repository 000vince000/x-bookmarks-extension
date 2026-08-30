import { upsertBookmarks } from "./db.js";

const X_TAB_URLS = [
  "https://x.com/i/bookmarks*",
  "https://x.com/i/history*",
  "https://twitter.com/i/bookmarks*",
  "https://twitter.com/i/history*",
];

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "CAPTURE_BATCH") {
    upsertBookmarks(msg.records)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }

  if (msg?.type === "DELETE_BOOKMARK") {
    (async () => {
      const tabs = await chrome.tabs.query({ url: X_TAB_URLS });
      if (!tabs.length) {
        sendResponse({ ok: false, error: "No X tab open — open x.com/i/bookmarks or /i/history and try again." });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, msg, (res) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse(res);
      });
    })();
    return true; // keep the message channel open for the async response
  }
});

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("library.html");
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url });
  }
});
