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

// Quote tweets nest the quoted tweet the same way the outer entry nests its
// own tweet_results — without this, `legacy.full_text` on the outer tweet is
// often just a one-word reaction ("Troubling") with the actual substance
// sitting unread in this nested field.
function extractQuoted(tweet) {
  const quoted = unwrapTweetResult(tweet.quoted_status_result?.result);
  if (!quoted?.legacy) return null;
  const handle = extractScreenName(quoted.core?.user_results?.result);
  const text = decodeHtmlEntities(quoted.legacy.full_text || "");
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
    const quoted = extractQuoted(tweet);

    return {
      id: tweet.rest_id,
      authorHandle: screenName || "unknown",
      authorName: userCore?.name || userLegacy?.name || "unknown",
      authorAvatar: userAvatar?.image_url || userLegacy?.profile_image_url_https || "",
      text: quoted
        ? `${decodeHtmlEntities(legacy.full_text || "")}\n\n${quoted}`
        : decodeHtmlEntities(legacy.full_text || ""),
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
  if (!itemContent || itemContent.itemType !== "TimelineTweet") return null;
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
