// Runs in the page's own JS context (MAIN world) so it can see the same
// fetch/XHR calls the bookmarks page makes, and read the responses the
// browser already received — no extra requests, no token handling.
(() => {
  const BOOKMARK_URL_PATTERN = /\/graphql\/[^/]+\/(Bookmarks|BookmarkTimeline)/i;

  function postCapture(json) {
    window.postMessage(
      { source: "x-bookmarks-extension", type: "GRAPHQL_CAPTURE", payload: json },
      "*"
    );
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (url && BOOKMARK_URL_PATTERN.test(url)) {
        response
          .clone()
          .json()
          .then(postCapture)
          .catch(() => {});
      }
    } catch (_) {
      // never let capture break the page's own request
    }
    return response;
  };

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__xBookmarksUrl = url;
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  const originalXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        if (this.__xBookmarksUrl && BOOKMARK_URL_PATTERN.test(this.__xBookmarksUrl)) {
          postCapture(JSON.parse(this.responseText));
        }
      } catch (_) {
        // ignore
      }
    });
    return originalXhrSend.apply(this, args);
  };
})();
