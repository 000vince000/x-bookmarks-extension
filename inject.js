// Runs in the page's own JS context (MAIN world) so it can see the same
// fetch/XHR calls the bookmarks page makes, and read the responses the
// browser already received — no extra requests, no token handling.
(() => {
  const BOOKMARK_URL_PATTERN = /\/graphql\/[^/]+\/(Bookmarks|BookmarkTimeline)/i;
  const OWN_TWEETS_URL_PATTERN = /\/graphql\/[^/]+\/(UserOriginalsTimeline|UserRepliesTimeline)/i;
  const SEARCH_URL_PATTERN = /\/graphql\/[^/]+\/SearchTimeline/i;

  function captureKind(url) {
    if (BOOKMARK_URL_PATTERN.test(url)) return "bookmarks";
    if (OWN_TWEETS_URL_PATTERN.test(url)) return "ownTweets";
    if (SEARCH_URL_PATTERN.test(url)) return "search";
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
      if (url) sniffTweetDetailTemplate(url);
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

  function xApiHeaders(csrfToken) {
    return {
      authorization: BEARER,
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": "en",
    };
  }

  async function deleteBookmarkOnX(tweetId) {
    const csrfToken = getCsrfToken();
    if (!csrfToken) throw new Error("Missing ct0 cookie — are you logged into X in this tab?");

    const res = await window.fetch(
      `https://x.com/i/api/graphql/${DELETE_BOOKMARK_QUERY_ID}/DeleteBookmark`,
      {
        method: "POST",
        credentials: "include",
        headers: xApiHeaders(csrfToken),
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
        headers: xApiHeaders(csrfToken),
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

  // Thread expansion support (read-only). TweetDetail's queryId rotates,
  // and X rejects the request if any currently-required `features` flag is
  // missing — so instead of trusting hardcoded values, the queryId,
  // features and fieldToggles of any real TweetDetail request the page
  // itself makes (i.e. whenever you open a tweet on X) are sniffed, reused,
  // and remembered in x.com's localStorage across reloads. The defaults are
  // twscrape's (github.com/vladkens/twscrape, refreshed 2026-08-06) — only
  // used until a live request has been seen.
  const TWEET_DETAIL_URL_PATTERN = /\/graphql\/([^/]+)\/TweetDetail\?/;
  const TWEET_DETAIL_TEMPLATE_KEY = "x-bookmarks-extension:tweetDetailTemplate";
  const DEFAULT_TWEET_DETAIL_TEMPLATE = {
    queryId: "XMOz5h24KAZ86qKffKTLdQ",
    variables: {
      with_rux_injections: false,
      includePromotedContent: true,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: true,
      withBirdwatchNotes: true,
      withVoice: true,
      withV2Timeline: true,
    },
    features: JSON.stringify({
      articles_preview_enabled: false,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      communities_web_enable_tweet_community_results_fetch: true,
      creator_subscriptions_quote_tweet_preview_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      freedom_of_speech_not_reach_fetch_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      longform_notetweets_consumption_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      responsive_web_enhance_cards_enabled: false,
      responsive_web_graphql_exclude_directive_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_grok_community_note_auto_translation_is_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_grok_imagine_annotation_enabled: false,
      responsive_web_media_download_video_enabled: false,
      responsive_web_profile_redirect_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      rweb_tipjar_consumption_enabled: true,
      rweb_video_timestamps_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_awards_web_tipping_enabled: false,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      tweet_with_visibility_results_prefer_gql_media_interstitial_enabled: false,
      tweetypie_unmention_optimization_enabled: true,
      verified_phone_label_enabled: false,
      view_counts_everywhere_api_enabled: true,
      responsive_web_grok_analyze_button_fetch_trends_enabled: false,
      premium_content_api_read_enabled: false,
      profile_label_improvements_pcf_label_in_post_enabled: false,
      responsive_web_grok_share_attachment_enabled: false,
      responsive_web_grok_analyze_post_followups_enabled: false,
      responsive_web_grok_image_annotation_enabled: false,
      responsive_web_grok_analysis_button_from_backend: false,
      responsive_web_jetfuel_frame: false,
      rweb_video_screen_enabled: true,
      responsive_web_grok_show_grok_translated_post: true,
    }),
    fieldToggles: null,
  };

  function loadTweetDetailTemplate() {
    try {
      const saved = JSON.parse(localStorage.getItem(TWEET_DETAIL_TEMPLATE_KEY));
      if (saved?.queryId && saved?.features) return saved;
    } catch (_) {
      // fall through to defaults
    }
    return DEFAULT_TWEET_DETAIL_TEMPLATE;
  }

  let tweetDetailTemplate = loadTweetDetailTemplate();

  function sniffTweetDetailTemplate(url) {
    const match = url.match(TWEET_DETAIL_URL_PATTERN);
    if (!match) return;
    try {
      const params = new URL(url, location.origin).searchParams;
      const features = params.get("features");
      if (!features) return;
      // Per-request variables are stripped — only the shape is reused.
      const { focalTweetId, cursor, controller_data, ...variables } = JSON.parse(params.get("variables") || "{}");
      tweetDetailTemplate = {
        queryId: match[1],
        variables,
        features,
        fieldToggles: params.get("fieldToggles"),
      };
      localStorage.setItem(TWEET_DETAIL_TEMPLATE_KEY, JSON.stringify(tweetDetailTemplate));
    } catch (_) {
      // a malformed URL just means nothing new to learn
    }
  }

  // X reports the caller's budget on every response — how many requests
  // this window allows, how many are left, and when it resets (epoch
  // seconds). Passed along so the library can pace itself by the real
  // limit rather than a guessed one. null when X didn't send the headers.
  function readRateLimit(res) {
    const limit = Number(res.headers.get("x-rate-limit-limit"));
    const remaining = Number(res.headers.get("x-rate-limit-remaining"));
    const reset = Number(res.headers.get("x-rate-limit-reset"));
    if (!reset || Number.isNaN(remaining)) return null;
    return { limit: limit || null, remaining, reset };
  }

  // Returns the raw response for content.js to parse (parse.js lives in
  // the isolated world, not here), along with the rate-limit budget — on a
  // 429 too, so the caller can pause until the reset instead of failing.
  async function fetchTweetDetail(focalTweetId, cursor) {
    const csrfToken = getCsrfToken();
    if (!csrfToken) return { ok: false, error: "Missing ct0 cookie — are you logged into X in this tab?" };

    const t = tweetDetailTemplate;
    const variables = { ...t.variables, focalTweetId, ...(cursor ? { cursor, referrer: "tweet" } : {}) };
    const params = new URLSearchParams({ variables: JSON.stringify(variables), features: t.features });
    if (t.fieldToggles) params.set("fieldToggles", t.fieldToggles);

    const res = await window.fetch(`https://x.com/i/api/graphql/${t.queryId}/TweetDetail?${params}`, {
      credentials: "include",
      headers: xApiHeaders(csrfToken),
    });
    const rateLimit = readRateLimit(res);
    if (res.status === 429) return { ok: false, rateLimited: true, rateLimit, error: "Rate limited by X" };

    let json = null;
    try {
      json = await res.json();
    } catch (_) {
      // non-JSON error body — fall through to status-based error below
    }
    if (!res.ok) return { ok: false, rateLimit, error: json?.errors?.[0]?.message || `HTTP ${res.status}` };
    return { ok: true, json, rateLimit };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "x-bookmarks-extension" || msg.type !== "TWEET_DETAIL_REQUEST") return;

    fetchTweetDetail(msg.focalTweetId, msg.cursor)
      .catch((err) => ({ ok: false, error: String(err?.message || err) }))
      .then((result) => {
        window.postMessage(
          { source: "x-bookmarks-extension", type: "TWEET_DETAIL_RESULT", requestId: msg.requestId, ...result },
          "*"
        );
      });
  });

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__xBookmarksUrl = url;
    if (typeof url === "string") sniffTweetDetailTemplate(url);
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
