# x-bookmarks-extension

Chrome extension for capturing, searching, and organizing X.com (Twitter) bookmarks locally.

It also includes an experimental FinTwit Research Feed. Give it a small
watchlist of labeled X searches and it runs them sequentially in inactive
tabs, captures the results locally, and ranks them with transparent quality
signals such as prior saved authors, substantive analysis, cited links,
specific figures, engagement velocity, and promotional-language penalties.
The feed is deliberately a review queue rather than a truth engine: discoveries
can be kept, marked done, opened on X, or copied as a Markdown research candidate.
The default queue gates out low-scoring posts, ticker roundups, short-term price
action, and technical analysis; captured-but-filtered posts remain inspectable
under **Low signal**, and the minimum quality score is adjustable.

X.com's bookmarks UI has no real search or filtering, and there's no free bulk API to export them. This extension captures bookmark data as you browse the bookmarks page (by reading the same GraphQL responses the page already loads), stores it locally in IndexedDB, and provides a searchable/filterable library page with tagging and notes.

## Load it

1. `chrome://extensions` → enable Developer mode → "Load unpacked" → select this directory.
2. Visit `https://x.com/i/bookmarks`. A small status bar appears bottom-right showing a live capture count.
3. Click "Auto-scroll & capture all" to scroll through your entire bookmark history once (it stops on its own once nothing new loads for a few seconds). On later visits, just scrolling the page captures anything new.
4. Click the extension's toolbar icon to open the library tab — search, filter by author/tag/media, add tags and notes.
5. Open **FinTwit Research Feed** from the library, edit the starter searches if needed, and click **Scan FinTwit**. Stay logged into X; the extension runs one inactive search tab at a time and closes it when that query goes idle.

## How capture works

`inject.js` runs in the page's own JS context and patches `fetch`/`XHR` to read the responses to X's internal Bookmarks GraphQL calls (no extra requests, no auth handling needed — it's just reading data your browser already received). `content.js` forwards new tweets to `background.js`, which writes them to IndexedDB (deduped by tweet id, preserving any tags/notes you've already added).

## Known fragile spot

`parse.js` walks X's GraphQL response shape (`timeline.instructions → entries → itemContent → tweet_results`). X occasionally changes this shape or the GraphQL query id in the URL. The parser matches on the operation name (`Bookmarks`/`BookmarkTimeline`) rather than a hardcoded query id, and every parse step is try/catch'd so a shape change skips entries instead of crashing capture — but if bookmarks stop being captured, this is the first place to check (open DevTools → Network → filter `graphql` while on the bookmarks page, compare the real response shape against `parse.js`).

Research search capture has the same dependency on X's unsupported internal
response shapes. Its quality score is a transparent triage heuristic, not a
truth or source-authority score; it is intended to reduce review volume and
learn from which authors already appear in your bookmarks.

## Thread expansion

"Expand threads" in the library checks bookmarks for tweetstorms and flattens each into the author's full self-reply chain (search, embeddings and grouping then see the whole thread; the card shows it tweet by tweet). It fetches X's `TweetDetail` query through an open bookmarks/history tab, paced by the rate-limit budget X reports on each response (spread evenly over the current window, so it runs as fast as X allows; a fixed 6s interval if X sends no budget), pausing until the reset time if the limit is hit anyway. Bookmarks captured before this feature need one more auto-scroll of the bookmarks page to pick up the reply-chain ids detection relies on. `TweetDetail`'s queryId and required `features` rotate — the extension reuses whatever the page itself last sent (open any tweet on X to refresh them), falling back to hardcoded defaults in `inject.js`. Paging through a very long thread's "show more" cursor is untested against a live response.

## Known limitations

- **X Articles** — `parse.js` now pulls in `tweet.article.article_results.result`'s `title` + `preview_text` (checked on both the outer tweet and a quoted tweet), instead of just the bare article URL that `legacy.full_text` gives for an article-share. Note `preview_text` is a truncated excerpt, not the full article body — X doesn't expose the complete text via this endpoint, so this is a real improvement but not complete capture.
- **Long "Note Tweets"** — for X's extended-length tweets (the ones with a "Show more" cutoff on X's own UI), `legacy.full_text` is often just a truncated preview, not the real content. `parse.js`'s `extractFullText` now prefers `tweet.note_tweet.note_tweet_results.result.text` when present, falling back to `legacy.full_text` for normal tweets. Verified against synthetic data matching the documented shape, not yet confirmed against a real captured long tweet.
- **Video thumbnails** — `library.js` now renders `.mp4` media URLs as `<video>` instead of `<img>` (detected purely from the URL, so it applies to already-captured data too, no re-capture needed). The original bug (wrong tag for the content type) is fixed; untested whether X's video CDN still resets the connection for requests from a `chrome-extension://` origin regardless of tag type — if videos still fail to load, that's the next thing to check.

## Status

Core capture pipeline, storage, and library UI are scaffolded. Not yet verified against live X.com responses — the GraphQL parsing in `parse.js` is based on the publicly known shape and may need adjustment on first real test.
