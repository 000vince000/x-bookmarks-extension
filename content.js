// Isolated-world content script: receives captured GraphQL payloads from
// inject.js (MAIN world), parses them via parse.js, persists new records
// through the background worker, and drives the on-page capture UI.
(() => {
  // Kept per-kind, not shared: the same tweet id can legitimately need to
  // reach both destinations (e.g. you bookmarked one of your own tweets),
  // so "already seen" for one corpus shouldn't suppress the other.
  const seenIds = { bookmarks: new Set(), ownTweets: new Set(), search: new Set() };
  let capturedTotal = 0;
  let researchCapturedTotal = 0;
  let lastNewCaptureAt = Date.now();
  let lastNewResearchCaptureAt = Date.now();
  let statusEl;

  function currentSearchQuery() {
    if (!/^\/(search|i\/search)/.test(location.pathname)) return "";
    return new URL(location.href).searchParams.get("q") || "";
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "x-bookmarks-extension" || msg.type !== "GRAPHQL_CAPTURE") return;

    const isSearch = msg.kind === "search";
    const isOwnTweets = msg.kind === "ownTweets";
    const records = isSearch
      ? parseSearchResponse(msg.payload)
      : isOwnTweets
        ? parseOwnTweetsResponse(msg.payload)
        : parseBookmarksResponse(msg.payload);
    const kind = isSearch ? "search" : isOwnTweets ? "ownTweets" : "bookmarks";
    const seen = seenIds[kind];
    const newRecords = records.filter((r) => !seen.has(r.id));
    if (!newRecords.length) return;

    newRecords.forEach((r) => seen.add(r.id));
    if (isSearch) {
      researchCapturedTotal += newRecords.length;
      lastNewResearchCaptureAt = Date.now();
      lastNewCaptureAt = lastNewResearchCaptureAt;
    } else {
      capturedTotal += newRecords.length;
      lastNewCaptureAt = Date.now();
    }

    const messageType = isSearch ? "RESEARCH_BATCH" : isOwnTweets ? "OWN_TWEETS_BATCH" : "CAPTURE_BATCH";
    chrome.runtime.sendMessage({ type: messageType, records: newRecords, query: currentSearchQuery() }, (res) => {
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

  // A research scan is deliberately bounded: scroll until X has produced
  // no new search results for a short window, then hand control back to the
  // background worker so it can close this tab and start the next query.
  let researchPageScanning = false;
  const RESEARCH_IDLE_LIMIT_MS = 7000;
  const RESEARCH_SCROLL_INTERVAL_MS = 1250;
  const RESEARCH_MAX_SCROLLS = 24;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "START_RESEARCH_PAGE_SCAN") return;
    if (researchPageScanning) {
      sendResponse({ ok: false, error: "search page is already scanning" });
      return;
    }
    researchPageScanning = true;
    lastNewResearchCaptureAt = Date.now();
    let scrolls = 0;
    sendResponse({ ok: true });

    const step = () => {
      if (!researchPageScanning) return;
      window.scrollTo(0, document.body.scrollHeight);
      scrolls++;
      const idle = Date.now() - lastNewResearchCaptureAt > RESEARCH_IDLE_LIMIT_MS;
      if (idle || scrolls >= RESEARCH_MAX_SCROLLS) {
        researchPageScanning = false;
        chrome.runtime.sendMessage({
          type: "RESEARCH_PAGE_DONE",
          scanId: msg.scanId,
          captured: researchCapturedTotal,
        });
        return;
      }
      setTimeout(step, RESEARCH_SCROLL_INTERVAL_MS);
    };
    step();
    return true;
  });

  // Same relay pattern as DELETE_BOOKMARK, for liking a tweet on X.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "LIKE_TWEET") return;
    const requestId = `like-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const onResult = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== "x-bookmarks-extension" || data.type !== "LIKE_TWEET_RESULT") return;
      if (data.requestId !== requestId) return;
      window.removeEventListener("message", onResult);
      sendResponse({ ok: data.ok, error: data.error });
    };
    window.addEventListener("message", onResult);

    window.postMessage(
      { source: "x-bookmarks-extension", type: "LIKE_TWEET_REQUEST", tweetId: msg.tweetId, requestId },
      "*"
    );
    return true; // keep the message channel open for the async response
  });

  // Thread expansion: relays TweetDetail fetches into the MAIN world (same
  // reason as DELETE_BOOKMARK) and assembles the author's thread here,
  // where parse.js is available.
  function requestTweetDetail(focalTweetId, cursor) {
    const requestId = `thread-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const onResult = (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "x-bookmarks-extension" || data.type !== "TWEET_DETAIL_RESULT") return;
        if (data.requestId !== requestId) return;
        window.removeEventListener("message", onResult);
        resolve(data);
      };
      window.addEventListener("message", onResult);
      window.postMessage(
        { source: "x-bookmarks-extension", type: "TWEET_DETAIL_REQUEST", focalTweetId, cursor, requestId },
        "*"
      );
    });
  }

  // Caps "show more" paging on a single thread — a runaway cursor loop
  // shouldn't be able to burn the whole rate-limit window.
  const MAX_THREAD_PAGES = 10;

  // Resolves to { thread, requests, rateLimit } on success — `thread` is
  // the author's full self-reply chain as segments, or [] when the
  // bookmark isn't part of one (including when it's been deleted) — or
  // throws with the rate-limit details attached. `rateLimit` is X's budget
  // as of the last request made; `requests` is the fallback pacing signal
  // when X doesn't report one.
  async function expandThread(tweetId, conversationId) {
    let requests = 0;
    let rateLimit = null;
    const fetchPage = async (focalTweetId, cursor) => {
      requests++;
      const res = await requestTweetDetail(focalTweetId, cursor);
      rateLimit = res.rateLimit || rateLimit;
      if (!res.ok) throw Object.assign(new Error(res.error), res, { rateLimit });
      const page = parseTweetDetailResponse(res.json);
      if (page.error && !page.notFound) throw new Error(page.error);
      return page;
    };

    // Bookmarks captured before reply-chain ids were stored don't know
    // their thread's first tweet — look at the bookmarked tweet itself
    // first to find it.
    let headId = conversationId || tweetId;
    let page = await fetchPage(headId);
    if (!conversationId) {
      const focal = page.tweets.find((t) => t.id === tweetId);
      if (focal?.conversationId && focal.conversationId !== tweetId) {
        headId = focal.conversationId;
        page = await fetchPage(headId);
      }
    }

    let tweets = page.tweets;
    const authorId = tweets.find((t) => t.id === headId)?.authorId;
    const followedCursors = new Set();
    for (let pages = 1; pages < MAX_THREAD_PAGES; pages++) {
      // Only a cursor inside a module holding the author's self-replies
      // continues the thread — others page in other people's replies.
      const cursor = page.moduleCursors.find(
        (c) =>
          !followedCursors.has(c.value) &&
          c.tweets.some((t) => t.authorId === authorId && t.inReplyToUserId === authorId)
      );
      if (!cursor) break;
      followedCursors.add(cursor.value);
      page = await fetchPage(headId, cursor.value);
      tweets = tweets.concat(page.tweets);
    }

    const chain = buildSelfThread(tweets, headId);
    // A one-tweet "chain" isn't a thread, and a chain that doesn't contain
    // the bookmark (e.g. it replies to someone else's thread) isn't its thread.
    const isThread = chain.length > 1 && chain.some((t) => t.id === tweetId);
    const thread = isThread
      ? chain.map((t) => ({
          id: t.id,
          text: t.text,
          mediaUrls: t.mediaUrls,
          externalLinks: t.externalLinks,
          createdAt: t.createdAt,
          url: t.url,
        }))
      : [];
    return { thread, requests, rateLimit };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "EXPAND_THREAD") return;
    expandThread(msg.tweetId, msg.conversationId)
      .then(({ thread, requests, rateLimit }) => sendResponse({ ok: true, thread, requests, rateLimit }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: String(err?.message || err),
          rateLimited: !!err?.rateLimited,
          rateLimit: err?.rateLimit || null,
        })
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
    statusEl.textContent = currentSearchQuery() ? "Research captured: 0" : "Captured: 0";

    const btn = document.createElement("button");
    btn.textContent = currentSearchQuery() ? "Auto-scroll search" : "Auto-scroll & capture all";
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
    if (statusEl) {
      statusEl.textContent = currentSearchQuery()
        ? `Research captured: ${researchCapturedTotal}`
        : `Captured: ${capturedTotal}`;
    }
  }

  let scrolling = false;
  let scrollTimer = null;
  const IDLE_LIMIT_MS = 6000;
  const SCROLL_INTERVAL_MS = 1200;

  function toggleAutoScroll(btn) {
    if (scrolling) {
      scrolling = false;
      clearTimeout(scrollTimer);
      btn.textContent = currentSearchQuery() ? "Auto-scroll search" : "Auto-scroll & capture all";
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
        btn.textContent = currentSearchQuery() ? "Auto-scroll search" : "Auto-scroll & capture all";
        return;
      }
      scrollTimer = setTimeout(step, SCROLL_INTERVAL_MS);
    };
    step();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      injectUI();
      if (currentSearchQuery()) {
        chrome.runtime.sendMessage({ type: "RESEARCH_PAGE_READY", query: currentSearchQuery() });
      }
    });
  } else {
    injectUI();
    if (currentSearchQuery()) {
      chrome.runtime.sendMessage({ type: "RESEARCH_PAGE_READY", query: currentSearchQuery() });
    }
  }
})();
