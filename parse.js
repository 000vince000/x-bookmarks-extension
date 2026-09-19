// Parses X's internal Bookmarks GraphQL response into flat records.
// This is the part most likely to need adjustment if X changes its
// response shape — every step is defensive/try-catch'd so a shape
// drift degrades (skips entries) instead of crashing capture entirely.

function extractMediaUrls(mediaArray) {
  if (!Array.isArray(mediaArray)) return [];
  return mediaArray
    .map((m) => {
      if (m.type === "photo") return m.media_url_https;
      if (m.type === "video" || m.type === "animated_gif") {
        const variants = m.video_info?.variants || [];
        const best = variants
          .filter((v) => v.content_type === "video/mp4")
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        return best?.url || m.media_url_https;
      }
      return m.media_url_https;
    })
    .filter(Boolean);
}

// X's API sometimes returns full_text with <, >, & already HTML-entity-
// encoded (a legacy quirk) rather than as raw characters — decoded here so
// stored text is the real content, not markup. Left un-decoded, this
// pollutes embeddings/tokenization/search, not just display (and would
// double-escape into a visible "&lt;" if the UI HTML-escapes it for
// rendering, since it'd be escaping an "&" that's already part of an
// entity). Order matters: specific entities before &amp;, so a literal
// "&amp;lt;" decodes to the literal text "&lt;", not to "<".
function decodeHtmlEntities(text) {
  return (text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Long-form "Note Tweets" (X's extended-length tweet feature) store their
// real content separately from legacy.full_text, which for these tweets is
// often just a truncated preview — matching X's own UI "Show more" cutoff
// for long tweets, not the actual complete text.
function extractFullText(tweetObj) {
  const noteText = tweetObj?.note_tweet?.note_tweet_results?.result?.text;
  return decodeHtmlEntities(noteText || tweetObj?.legacy?.full_text || "");
}

function unwrapTweetResult(result) {
  if (!result) return null;
  if (result.__typename === "TweetWithVisibilityResults") return result.tweet;
  if (result.__typename === "TweetTombstone") return null; // deleted/protected
  return result;
}

// X split user fields out of the old `legacy` bag into separate `core`
// (name/screen_name) and `avatar` (image_url) objects — check both shapes
// since legacy may or may not still be populated.
function extractScreenName(userResult) {
  return userResult?.core?.screen_name || userResult?.legacy?.screen_name || "";
}

// An X Article (long-form post) attached to a tweet — either the outer
// tweet's own attachment or a quoted tweet's — has its title/preview text
// here, not in legacy.full_text (which for an article-share is just the
// article's bare URL).
function extractArticleText(tweetObj) {
  const article = tweetObj?.article?.article_results?.result;
  if (!article) return null;
  return [article.title, article.preview_text].filter(Boolean).join("\n\n");
}

// External links a tweet points to, for the library's "Link" filter/badge.
// entities.urls also carries the t.co link to a quoted tweet (and, for an
// X Article share, the article's own x.com link) — both already surfaced
// via isQuote/hasArticle, so anything hosted on x.com/twitter.com is
// excluded here to keep this signal specific to outside links.
function extractExternalLinks(tweetObj) {
  const urls = tweetObj?.legacy?.entities?.urls || [];
  return urls
    .map((u) => u.expanded_url || u.url)
    .filter((u) => u && !/^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(u));
}

// Quote tweets nest the quoted tweet the same way the outer entry nests its
// own tweet_results — without this, `legacy.full_text` on the outer tweet is
// often just a one-word reaction ("Troubling") with the actual substance
// sitting unread in this nested field. Takes the already-unwrapped quoted
// tweet object (shared with the hasArticle/isQuote flags below) rather than
// re-unwrapping internally.
function extractQuotedText(quoted) {
  if (!quoted?.legacy) return null;
  const handle = extractScreenName(quoted.core?.user_results?.result);
  const text = extractArticleText(quoted) || extractFullText(quoted);
  if (!text) return null;
  return handle ? `Quoting @${handle}: ${text}` : `Quoting: ${text}`;
}

function parseTweet(tweetResult) {
  try {
    const tweet = unwrapTweetResult(tweetResult);
    if (!tweet || !tweet.legacy || !tweet.rest_id) return null;

    const legacy = tweet.legacy;
    const userResult = tweet.core?.user_results?.result;
    const userCore = userResult?.core;
    const userLegacy = userResult?.legacy;
    const userAvatar = userResult?.avatar;

    const screenName = extractScreenName(userResult);
    if (!screenName) {
      console.warn("[x-bookmarks] could not resolve author, dumping shapes:", {
        tweetTopLevelKeys: Object.keys(tweet),
        userResult,
      });
    }
    const media = legacy.extended_entities?.media || legacy.entities?.media || [];
    const quotedTweet = unwrapTweetResult(tweet.quoted_status_result?.result);
    const quoted = extractQuotedText(quotedTweet);
    const ownArticle = extractArticleText(tweet);
    const quotedArticle = extractArticleText(quotedTweet);
    const text = [extractFullText(tweet), ownArticle, quoted].filter(Boolean).join("\n\n");
    const externalLinks = [
      ...new Set([...extractExternalLinks(tweet), ...extractExternalLinks(quotedTweet)]),
    ];

    return {
      id: tweet.rest_id,
      // Reply-chain ids — what identifies a bookmark as part of a
      // tweetstorm (see threadCheckTier in library.js), and what
      // buildSelfThread walks to reassemble one.
      authorId: userResult?.rest_id || legacy.user_id_str || null,
      conversationId: legacy.conversation_id_str || null,
      inReplyToId: legacy.in_reply_to_status_id_str || null,
      inReplyToUserId: legacy.in_reply_to_user_id_str || null,
      authorHandle: screenName || "unknown",
      authorName: userCore?.name || userLegacy?.name || "unknown",
      authorAvatar: userAvatar?.image_url || userLegacy?.profile_image_url_https || "",
      text,
      // Cheap content-type signal for the library UI's [Video]/[Image]/
      // [X Article]/[Quote]/[Link] badges — video/image are derived from
      // mediaUrls at render time instead, no need to store those separately.
      hasArticle: !!(ownArticle || quotedArticle),
      isQuote: !!quoted,
      externalLinks,
      createdAt: legacy.created_at ? new Date(legacy.created_at).toISOString() : null,
      capturedAt: new Date().toISOString(),
      mediaUrls: extractMediaUrls(media),
      likeCount: legacy.favorite_count || 0,
      retweetCount: legacy.retweet_count || 0,
      replyCount: legacy.reply_count || 0,
      url: screenName ? `https://x.com/${screenName}/status/${tweet.rest_id}` : "",
    };
  } catch (err) {
    console.warn("[x-bookmarks] failed to parse tweet entry", err);
    return null;
  }
}

function parseTweetFromItemContent(itemContent) {
  if (
    !itemContent ||
    (itemContent.itemType !== "TimelineTweet" && itemContent.__typename !== "TimelineTweet")
  ) {
    return null;
  }
  return parseTweet(itemContent.tweet_results?.result);
}

function parseBookmarksResponse(json) {
  const records = [];
  try {
    const timeline =
      json?.data?.bookmark_timeline_v2?.timeline || json?.data?.bookmark_timeline?.timeline;
    const instructions = timeline?.instructions || [];
    for (const instruction of instructions) {
      if (instruction.type !== "TimelineAddEntries") continue;
      for (const entry of instruction.entries || []) {
        const parsed = parseTweetFromItemContent(entry?.content?.itemContent);
        if (parsed) records.push(parsed);
      }
    }
  } catch (err) {
    console.warn("[x-bookmarks] failed to parse bookmarks response", err);
  }
  return records;
}

// SearchTimeline has changed its entry wrappers several times. Rather than
// couple research capture to one exact wrapper, walk the timeline entries
// and parse every object that identifies itself as a TimelineTweet. The
// payload is JSON (acyclic), and the timeline subtree is small enough that
// this defensive walk is cheap compared with the network request itself.
function parseSearchResponse(json) {
  const records = [];
  const seen = new Set();
  try {
    const timeline = json?.data?.search_by_raw_query?.search_timeline?.timeline;
    if (!timeline) return records;

    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (value.itemType === "TimelineTweet" || value.__typename === "TimelineTweet") {
        const parsed = parseTweetFromItemContent(value);
        if (parsed && !seen.has(parsed.id)) {
          seen.add(parsed.id);
          records.push(parsed);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      for (const child of Object.values(value)) visit(child);
    };

    visit(timeline.instructions || []);
  } catch (err) {
    console.warn("[x-bookmarks] failed to parse search response", err);
  }
  return records;
}

// UserOriginalsTimeline (Posts tab) / UserRepliesTimeline (Posts & Replies
// tab) share a different top-level shape than Bookmarks
// (data.user.result.timeline.timeline, not data.bookmark_timeline_v2), and
// mix two entry shapes: a flat TimelineTimelineItem per standalone post,
// and a TimelineTimelineModule (a "conversation" grouping a reply together
// with the tweet it's replying to) whose tweets sit one level deeper under
// content.items[].item.itemContent. Every tweet found — including the OP's
// tweet riding along inside a reply's module — gets filtered down to just
// OWN_HANDLE afterward, since the OP isn't something we want in this corpus.
const OWN_HANDLE = "vinnygarr";

function parseOwnTweetsResponse(json) {
  const records = [];
  try {
    const timeline = json?.data?.user?.result?.timeline?.timeline;
    const instructions = timeline?.instructions || [];
    for (const instruction of instructions) {
      const entries = instruction.entries || (instruction.entry ? [instruction.entry] : []);
      for (const entry of entries) {
        const content = entry?.content;
        if (!content) continue;
        if (content.__typename === "TimelineTimelineItem") {
          const parsed = parseTweetFromItemContent(content.itemContent);
          if (parsed) records.push(parsed);
        } else if (content.__typename === "TimelineTimelineModule") {
          for (const moduleItem of content.items || []) {
            const parsed = parseTweetFromItemContent(moduleItem?.item?.itemContent);
            if (parsed) records.push(parsed);
          }
        }
      }
    }
  } catch (err) {
    console.warn("[x-bookmarks] failed to parse own-tweets response", err);
  }
  return records.filter((r) => r.authorHandle.toLowerCase() === OWN_HANDLE);
}

// TweetDetail (what X loads when you open a single tweet) — used to expand
// a bookmarked tweetstorm into the author's whole thread. The conversation
// sits under threaded_conversation_with_injections_v2: the focal tweet as a
// flat item, then one TimelineTimelineModule per reply chain — the
// author's own continuation ("SelfThread") first, then everyone else's
// replies. A module X has truncated carries a "show more" cursor item
// inline; following one returns a TimelineAddToModule instruction with the
// next batch. Returns every tweet found, plus each module cursor alongside
// the tweets of the module it came from (so the caller can tell which
// cursor continues the author's thread). `notFound` is set when X reports
// the focal tweet as missing (deleted/protected) instead of a conversation.
function parseTweetDetailResponse(json) {
  const tweets = [];
  const moduleCursors = [];
  const conversation = json?.data?.threaded_conversation_with_injections_v2;
  if (!conversation) {
    const message = json?.errors?.[0]?.message || "";
    return { tweets, moduleCursors, notFound: /no status found|_Missing/i.test(message), error: message };
  }

  const collectModule = (items) => {
    const moduleTweets = [];
    let cursor = null;
    for (const moduleItem of items || []) {
      const itemContent = moduleItem?.item?.itemContent;
      if (itemContent?.itemType === "TimelineTimelineCursor" || itemContent?.__typename === "TimelineTimelineCursor") {
        cursor = itemContent.value || cursor;
        continue;
      }
      const parsed = parseTweetFromItemContent(itemContent);
      if (parsed) moduleTweets.push(parsed);
    }
    tweets.push(...moduleTweets);
    if (cursor) moduleCursors.push({ value: cursor, tweets: moduleTweets });
  };

  try {
    for (const instruction of conversation.instructions || []) {
      if (instruction.type === "TimelineAddToModule") {
        collectModule(instruction.moduleItems);
        continue;
      }
      if (instruction.type !== "TimelineAddEntries") continue;
      for (const entry of instruction.entries || []) {
        const content = entry?.content;
        if (content?.__typename === "TimelineTimelineModule" || content?.entryType === "TimelineTimelineModule") {
          collectModule(content.items);
        } else {
          const parsed = parseTweetFromItemContent(content?.itemContent);
          if (parsed) tweets.push(parsed);
        }
      }
    }
  } catch (err) {
    console.warn("[x-bookmarks] failed to parse TweetDetail response", err);
  }
  return { tweets, moduleCursors, notFound: false };
}

// Snowflake ids exceed Number precision — compare as BigInt.
function isEarlierTweetId(a, b) {
  return BigInt(a) < BigInt(b);
}

// The author's self-reply chain starting at `headId`: each next link is
// the author's reply to the previous link. Replies to anyone else — even
// by the author — aren't part of it. If the author replied to the same
// tweet of theirs more than once (a fork), the earliest reply is taken as
// the continuation. Returns [] when the head isn't among `tweets`.
function buildSelfThread(tweets, headId) {
  const byId = new Map(tweets.map((t) => [t.id, t]));
  const head = byId.get(headId);
  if (!head) return [];

  const continuationOf = new Map();
  for (const t of byId.values()) {
    if (t.authorId !== head.authorId || !t.inReplyToId) continue;
    const existing = continuationOf.get(t.inReplyToId);
    if (!existing || isEarlierTweetId(t.id, existing.id)) continuationOf.set(t.inReplyToId, t);
  }

  const chain = [head];
  const seen = new Set([head.id]);
  let next;
  while ((next = continuationOf.get(chain[chain.length - 1].id)) && !seen.has(next.id)) {
    chain.push(next);
    seen.add(next.id);
  }
  return chain;
}
