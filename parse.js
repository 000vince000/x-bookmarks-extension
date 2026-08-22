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

function unwrapTweetResult(result) {
  if (!result) return null;
  if (result.__typename === "TweetWithVisibilityResults") return result.tweet;
  if (result.__typename === "TweetTombstone") return null; // deleted/protected
  return result;
}

function parseTweet(tweetResult) {
  try {
    const tweet = unwrapTweetResult(tweetResult);
    if (!tweet || !tweet.legacy || !tweet.rest_id) return null;

    const legacy = tweet.legacy;
    const userResult = tweet.core?.user_results?.result;
    // X split user fields out of the old `legacy` bag into separate
    // `core` (name/screen_name) and `avatar` (image_url) objects — check
    // both shapes since legacy may or may not still be populated.
    const userCore = userResult?.core;
    const userLegacy = userResult?.legacy;
    const userAvatar = userResult?.avatar;

    const screenName = userCore?.screen_name || userLegacy?.screen_name;
    if (!screenName) {
      console.warn("[x-bookmarks] could not resolve author, dumping shapes:", {
        tweetTopLevelKeys: Object.keys(tweet),
        userResult,
      });
    }
    const media = legacy.extended_entities?.media || legacy.entities?.media || [];

    return {
      id: tweet.rest_id,
      authorHandle: screenName || "unknown",
      authorName: userCore?.name || userLegacy?.name || "unknown",
      authorAvatar: userAvatar?.image_url || userLegacy?.profile_image_url_https || "",
      text: legacy.full_text || "",
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

function parseBookmarksResponse(json) {
  const records = [];
  try {
    const timeline =
      json?.data?.bookmark_timeline_v2?.timeline || json?.data?.bookmark_timeline?.timeline;
    const instructions = timeline?.instructions || [];
    for (const instruction of instructions) {
      if (instruction.type !== "TimelineAddEntries") continue;
      for (const entry of instruction.entries || []) {
        const itemContent = entry?.content?.itemContent;
        if (!itemContent || itemContent.itemType !== "TimelineTweet") continue;
        const parsed = parseTweet(itemContent.tweet_results?.result);
        if (parsed) records.push(parsed);
      }
    }
  } catch (err) {
    console.warn("[x-bookmarks] failed to parse bookmarks response", err);
  }
  return records;
}
