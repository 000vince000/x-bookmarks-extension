# x-bookmarks-extension

Chrome extension for capturing, searching, and organizing X.com (Twitter) bookmarks locally.

X.com's bookmarks UI has no real search or filtering, and there's no free bulk API to export them. This extension captures bookmark data as you browse the bookmarks page (by reading the same GraphQL responses the page already loads), stores it locally in IndexedDB, and provides a searchable/filterable library page with tagging and notes.

## Load it

1. `chrome://extensions` → enable Developer mode → "Load unpacked" → select this directory.
2. Visit `https://x.com/i/bookmarks`. A small status bar appears bottom-right showing a live capture count.
3. Click "Auto-scroll & capture all" to scroll through your entire bookmark history once (it stops on its own once nothing new loads for a few seconds). On later visits, just scrolling the page captures anything new.
4. Click the extension's toolbar icon to open the library tab — search, filter by author/tag/media, add tags and notes.

## How capture works

`inject.js` runs in the page's own JS context and patches `fetch`/`XHR` to read the responses to X's internal Bookmarks GraphQL calls (no extra requests, no auth handling needed — it's just reading data your browser already received). `content.js` forwards new tweets to `background.js`, which writes them to IndexedDB (deduped by tweet id, preserving any tags/notes you've already added).

## Known fragile spot

`parse.js` walks X's GraphQL response shape (`timeline.instructions → entries → itemContent → tweet_results`). X occasionally changes this shape or the GraphQL query id in the URL. The parser matches on the operation name (`Bookmarks`/`BookmarkTimeline`) rather than a hardcoded query id, and every parse step is try/catch'd so a shape change skips entries instead of crashing capture — but if bookmarks stop being captured, this is the first place to check (open DevTools → Network → filter `graphql` while on the bookmarks page, compare the real response shape against `parse.js`).

## Known limitations

- **X Articles** — `parse.js` now pulls in `tweet.article.article_results.result`'s `title` + `preview_text` (checked on both the outer tweet and a quoted tweet), instead of just the bare article URL that `legacy.full_text` gives for an article-share. Note `preview_text` is a truncated excerpt, not the full article body — X doesn't expose the complete text via this endpoint, so this is a real improvement but not complete capture.
- **Video thumbnails** — `library.js` now renders `.mp4` media URLs as `<video>` instead of `<img>` (detected purely from the URL, so it applies to already-captured data too, no re-capture needed). The original bug (wrong tag for the content type) is fixed; untested whether X's video CDN still resets the connection for requests from a `chrome-extension://` origin regardless of tag type — if videos still fail to load, that's the next thing to check.

## Status

Core capture pipeline, storage, and library UI are scaffolded. Not yet verified against live X.com responses — the GraphQL parsing in `parse.js` is based on the publicly known shape and may need adjustment on first real test.
