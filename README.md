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

- **Quoted X Articles aren't captured.** `parse.js` unwraps a quote-tweet's nested `quoted_status_result` to pull in the quoted tweet's text, but if the quoted content is an X Article (long-form post) rather than a normal tweet, `legacy.full_text` on it is just the article's URL — the actual title/body lives in a different, not-yet-identified part of the response. TODO: find that shape and pull in at least the article title.
- **Video thumbnails render broken.** `library.js`'s card rendering puts every media URL — including `.mp4` video URLs extracted by `parse.js` — into a plain `<img>` tag. Browsers can't decode video as an image, and X's video CDN resets the connection for these requests from a `chrome-extension://` origin. TODO: render `<video>` for video media instead of `<img>`.

## Status

Core capture pipeline, storage, and library UI are scaffolded. Not yet verified against live X.com responses — the GraphQL parsing in `parse.js` is based on the publicly known shape and may need adjustment on first real test.
