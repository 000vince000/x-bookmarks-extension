// Isolated-world content script: receives captured GraphQL payloads from
// inject.js (MAIN world), parses them via parse.js, persists new records
// through the background worker, and drives the on-page capture UI.
(() => {
  const seenIds = new Set();
  let capturedTotal = 0;
  let lastNewCaptureAt = Date.now();
  let statusEl;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "x-bookmarks-extension" || msg.type !== "GRAPHQL_CAPTURE") return;

    const records = parseBookmarksResponse(msg.payload);
    const newRecords = records.filter((r) => !seenIds.has(r.id));
    if (!newRecords.length) return;

    newRecords.forEach((r) => seenIds.add(r.id));
    capturedTotal += newRecords.length;
    lastNewCaptureAt = Date.now();

    chrome.runtime.sendMessage({ type: "CAPTURE_BATCH", records: newRecords }, (res) => {
      if (!res?.ok) console.warn("[x-bookmarks] capture batch failed", res?.error);
    });

    updateStatus();
  });

  // Relays a delete request from the background worker into the MAIN-world
  // script (only it can issue the real, page-authenticated fetch) and
  // relays the result back.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "DELETE_BOOKMARK") return;
    const requestId = `del-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const onResult = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== "x-bookmarks-extension" || data.type !== "DELETE_BOOKMARK_RESULT") return;
      if (data.requestId !== requestId) return;
      window.removeEventListener("message", onResult);
      sendResponse({ ok: data.ok, error: data.error });
    };
    window.addEventListener("message", onResult);

    window.postMessage(
      { source: "x-bookmarks-extension", type: "DELETE_BOOKMARK_REQUEST", tweetId: msg.tweetId, requestId },
      "*"
    );
    return true; // keep the message channel open for the async response
  });

  function injectUI() {
    const bar = document.createElement("div");
    bar.id = "x-bookmarks-status-bar";
    bar.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 9999;
      background: #15202b; color: #fff; font: 13px system-ui, sans-serif;
      padding: 10px 14px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,.4);
      display: flex; gap: 10px; align-items: center;
    `;
    statusEl = document.createElement("span");
    statusEl.textContent = "Captured: 0";

    const btn = document.createElement("button");
    btn.textContent = "Auto-scroll & capture all";
    btn.style.cssText = `
      background: #1d9bf0; color: #fff; border: none; border-radius: 6px;
      padding: 6px 10px; cursor: pointer; font: inherit;
    `;
    btn.addEventListener("click", () => toggleAutoScroll(btn));

    bar.appendChild(statusEl);
    bar.appendChild(btn);
    document.body.appendChild(bar);
  }

  function updateStatus() {
    if (statusEl) statusEl.textContent = `Captured: ${capturedTotal}`;
  }

  let scrolling = false;
  let scrollTimer = null;
  const IDLE_LIMIT_MS = 6000;
  const SCROLL_INTERVAL_MS = 1200;

  function toggleAutoScroll(btn) {
    if (scrolling) {
      scrolling = false;
      clearTimeout(scrollTimer);
      btn.textContent = "Auto-scroll & capture all";
      return;
    }
    scrolling = true;
    btn.textContent = "Stop scrolling";
    lastNewCaptureAt = Date.now();

    const step = () => {
      if (!scrolling) return;
      window.scrollTo(0, document.body.scrollHeight);
      if (Date.now() - lastNewCaptureAt > IDLE_LIMIT_MS) {
        scrolling = false;
        btn.textContent = "Auto-scroll & capture all";
        return;
      }
      scrollTimer = setTimeout(step, SCROLL_INTERVAL_MS);
    };
    step();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectUI);
  } else {
    injectUI();
  }
})();
