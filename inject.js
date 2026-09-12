// Runs in the page's own JS context (MAIN world) so it can see the same
// fetch/XHR calls the bookmarks page makes, and read the responses the
// browser already received — no extra requests, no token handling.
(() => {
  const BOOKMARK_URL_PATTERN = /\/graphql\/[^/]+\/(Bookmarks|BookmarkTimeline)/i;
  const OWN_TWEETS_URL_PATTERN = /\/graphql\/[^/]+\/(UserOriginalsTimeline|UserRepliesTimeline)/i;

  function captureKind(url) {
    if (BOOKMARK_URL_PATTERN.test(url)) return "bookmarks";
    if (OWN_TWEETS_URL_PATTERN.test(url)) return "ownTweets";
    return null;
  }

  function postCapture(kind, json) {
    window.postMessage(
      { source: "x-bookmarks-extension", type: "GRAPHQL_CAPTURE", kind, payload: json },
      "*"
    );
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      const kind = url && captureKind(url);
      if (kind) {
        response
          .clone()
          .json()
          .then((json) => postCapture(kind, json))
          .catch(() => {});
      }
    } catch (_) {
      // never let capture break the page's own request
    }
    return response;
  };

  // Unbookmark-on-X support. This is a real persisted GraphQL mutation
  // (queryId captured live from DevTools, not guessed), issued via the
  // page's *current* window.fetch — not a saved-at-load reference — so
  // that if X's own app code patches fetch to attach its anti-automation
  // x-client-transaction-id header, we inherit that for free rather than
  // trying to reverse-engineer their integrity-token algorithm ourselves.
  const DELETE_BOOKMARK_QUERY_ID = "Wlmlj2-xzyS1GN3a6cj-mQ";
  const BEARER =
    "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

  function getCsrfToken() {
    const match = document.cookie.match(/(?:^|; )ct0=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function deleteBookmarkOnX(tweetId) {
    const csrfToken = getCsrfToken();
    if (!csrfToken) throw new Error("Missing ct0 cookie — are you logged into X in this tab?");

    const res = await window.fetch(
      `https://x.com/i/api/graphql/${DELETE_BOOKMARK_QUERY_ID}/DeleteBookmark`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          authorization: BEARER,
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
          "x-twitter-active-user": "yes",
          "x-twitter-auth-type": "OAuth2Session",
          "x-twitter-client-language": "en",
        },
        body: JSON.stringify({ variables: { tweet_id: tweetId }, queryId: DELETE_BOOKMARK_QUERY_ID }),
      }
    );

    let json = null;
    try {
      json = await res.json();
    } catch (_) {
      // non-JSON error body — fall through to status-based error below
    }
    if (!res.ok || json?.errors) {
      throw new Error(json?.errors?.[0]?.message || `HTTP ${res.status}`);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "x-bookmarks-extension" || msg.type !== "DELETE_BOOKMARK_REQUEST") return;

    deleteBookmarkOnX(msg.tweetId)
      .then(() => {
        window.postMessage(
          { source: "x-bookmarks-extension", type: "DELETE_BOOKMARK_RESULT", requestId: msg.requestId, ok: true },
          "*"
        );
      })
      .catch((err) => {
        window.postMessage(
          {
            source: "x-bookmarks-extension",
            type: "DELETE_BOOKMARK_RESULT",
            requestId: msg.requestId,
            ok: false,
            error: String(err?.message || err),
          },
          "*"
        );
      });
  });

  // Like-on-X support. Unlike DELETE_BOOKMARK_QUERY_ID (captured live from
  // DevTools), this queryId is a publicly-documented value from open-source
  // X API clients, not one we captured ourselves — X rotates these
  // periodically, so if this starts failing, re-capture the current
  // queryId from DevTools (Network tab, filter "Favorite") and swap it in.
  const FAVORITE_TWEET_QUERY_ID = "lI07N6Otwv1PhnEgXILM7A";

  async function likeTweetOnX(tweetId) {
    const csrfToken = getCsrfToken();
    if (!csrfToken) throw new Error("Missing ct0 cookie — are you logged into X in this tab?");

    const res = await window.fetch(
      `https://x.com/i/api/graphql/${FAVORITE_TWEET_QUERY_ID}/FavoriteTweet`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          authorization: BEARER,
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
          "x-twitter-active-user": "yes",
          "x-twitter-auth-type": "OAuth2Session",
          "x-twitter-client-language": "en",
        },
        body: JSON.stringify({ variables: { tweet_id: tweetId }, queryId: FAVORITE_TWEET_QUERY_ID }),
      }
    );

    let json = null;
    try {
      json = await res.json();
    } catch (_) {
      // non-JSON error body — fall through to status-based error below
    }
    if (!res.ok || json?.errors) {
      throw new Error(json?.errors?.[0]?.message || `HTTP ${res.status}`);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "x-bookmarks-extension" || msg.type !== "LIKE_TWEET_REQUEST") return;

    likeTweetOnX(msg.tweetId)
      .then(() => {
        window.postMessage(
          { source: "x-bookmarks-extension", type: "LIKE_TWEET_RESULT", requestId: msg.requestId, ok: true },
          "*"
        );
      })
      .catch((err) => {
        window.postMessage(
          {
            source: "x-bookmarks-extension",
            type: "LIKE_TWEET_RESULT",
            requestId: msg.requestId,
            ok: false,
            error: String(err?.message || err),
          },
          "*"
        );
      });
  });

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__xBookmarksUrl = url;
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  const originalXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        const kind = this.__xBookmarksUrl && captureKind(this.__xBookmarksUrl);
        if (kind) {
          postCapture(kind, JSON.parse(this.responseText));
        }
      } catch (_) {
        // ignore
      }
    });
    return originalXhrSend.apply(this, args);
  };
})();
