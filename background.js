import { upsertBookmarks, upsertOwnTweets, upsertResearchPosts } from "./db.js";

const X_TAB_URLS = [
  "https://x.com/i/bookmarks*",
  "https://x.com/i/history*",
  "https://twitter.com/i/bookmarks*",
  "https://twitter.com/i/history*",
];

const RESEARCH_SCAN_KEY = "researchScanState";

async function getResearchScanState() {
  return (await chrome.storage.session.get(RESEARCH_SCAN_KEY))[RESEARCH_SCAN_KEY] || null;
}

async function setResearchScanState(state) {
  await chrome.storage.session.set({ [RESEARCH_SCAN_KEY]: state });
  chrome.runtime.sendMessage({ type: "RESEARCH_SCAN_PROGRESS", state }).catch(() => {});
}

function publicScanState(state) {
  if (!state) return { status: "idle", completed: 0, total: 0, newPosts: 0 };
  return {
    status: state.status,
    scanId: state.scanId,
    completed: state.index,
    total: state.jobs.length,
    currentLabel: state.current?.label || null,
    newPosts: state.newPosts || 0,
    updatedPosts: state.updatedPosts || 0,
    error: state.error || null,
  };
}

async function broadcastScanState(state) {
  const next = { ...state, public: publicScanState(state) };
  await setResearchScanState(next);
  return next;
}

async function openNextResearchSearch(state) {
  if (state.index >= state.jobs.length) {
    state.status = "complete";
    state.current = null;
    state.finishedAt = new Date().toISOString();
    await broadcastScanState(state);
    return;
  }

  const job = state.jobs[state.index];
  // Create a blank inactive tab first so the scan state is durable before
  // the X content script can announce that the real search page is ready.
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  state.current = { ...job, tabId: tab.id };
  await broadcastScanState(state);
  const url = `https://x.com/search?q=${encodeURIComponent(job.query)}&src=typed_query&f=live`;
  await chrome.tabs.update(tab.id, { url });
}

async function failResearchScan(state, error) {
  const tabId = state.current?.tabId;
  state.status = "error";
  state.error = String(error?.message || error);
  state.current = null;
  state.finishedAt = new Date().toISOString();
  await broadcastScanState(state);
  if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
}

async function startResearchScan(jobs) {
  const current = await getResearchScanState();
  if (current?.status === "running") throw new Error("A FinTwit scan is already running");
  const state = {
    status: "running",
    scanId: `research-${Date.now()}`,
    jobs,
    index: 0,
    current: null,
    newPosts: 0,
    updatedPosts: 0,
    startedAt: new Date().toISOString(),
  };
  await broadcastScanState(state);
  try {
    await openNextResearchSearch(state);
  } catch (error) {
    await failResearchScan(state, error);
    throw error;
  }
  return publicScanState(state);
}

async function finishResearchPage(tabId, scanId) {
  const state = await getResearchScanState();
  if (state?.status !== "running" || state.scanId !== scanId || state.current?.tabId !== tabId) return;
  state.index++;
  state.current = null;
  await broadcastScanState(state);
  await chrome.tabs.remove(tabId).catch(() => {});
  try {
    await openNextResearchSearch(state);
  } catch (error) {
    await failResearchScan(state, error);
  }
}

async function stopResearchScan() {
  const state = await getResearchScanState();
  if (!state || state.status !== "running") return publicScanState(state);
  const tabId = state.current?.tabId;
  state.status = "stopped";
  state.current = null;
  state.finishedAt = new Date().toISOString();
  await broadcastScanState(state);
  if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
  return publicScanState(state);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "CAPTURE_BATCH") {
    upsertBookmarks(msg.records)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }

  if (msg?.type === "OWN_TWEETS_BATCH") {
    upsertOwnTweets(msg.records)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }

  if (msg?.type === "RESEARCH_BATCH") {
    (async () => {
      const state = await getResearchScanState();
      const activeJob = state?.status === "running" && state.current?.tabId === _sender.tab?.id ? state.current : null;
      const match = {
        label: activeJob?.label || msg.query || "X search",
        query: activeJob?.query || msg.query || "",
      };
      const result = await upsertResearchPosts(msg.records, match);
      if (activeJob) {
        state.newPosts += result.inserted;
        state.updatedPosts += result.updated;
        await broadcastScanState(state);
      }
      sendResponse({ ok: true, ...result });
    })().catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === "START_RESEARCH_SCAN") {
    const jobs = (msg.jobs || [])
      .map((job, i) => ({
        id: String(job.id || i),
        label: String(job.label || "Search").trim(),
        query: String(job.query || "").trim(),
      }))
      .filter((job) => job.query);
    if (!jobs.length) {
      sendResponse({ ok: false, error: "Add at least one watchlist query" });
      return;
    }
    startResearchScan(jobs)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === "STOP_RESEARCH_SCAN") {
    stopResearchScan()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === "GET_RESEARCH_SCAN_STATUS") {
    getResearchScanState()
      .then((state) => sendResponse({ ok: true, state: publicScanState(state) }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === "RESEARCH_PAGE_READY") {
    (async () => {
      const state = await getResearchScanState();
      if (state?.status !== "running" || state.current?.tabId !== _sender.tab?.id) {
        sendResponse({ ok: true, scan: false });
        return;
      }
      const pageResponse = await chrome.tabs.sendMessage(_sender.tab.id, {
        type: "START_RESEARCH_PAGE_SCAN",
        scanId: state.scanId,
      });
      sendResponse({ ok: pageResponse?.ok !== false, scan: pageResponse?.ok !== false, error: pageResponse?.error });
    })().catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === "RESEARCH_PAGE_DONE") {
    finishResearchPage(_sender.tab?.id, msg.scanId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === "DELETE_BOOKMARK" || msg?.type === "LIKE_TWEET" || msg?.type === "EXPAND_THREAD") {
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

// If the user closes the current inactive search tab, skip that query and
// continue instead of leaving the scan permanently stuck in "running".
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getResearchScanState();
  if (state?.status !== "running" || state.current?.tabId !== tabId) return;
  state.index++;
  state.current = null;
  await broadcastScanState(state);
  try {
    await openNextResearchSearch(state);
  } catch (error) {
    await failResearchScan(state, error);
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
