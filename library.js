import {
  getAllBookmarks,
  updateBookmarkMeta,
  setEmbedding,
  deleteBookmark as dbDeleteBookmark,
  archiveBookmark as dbArchiveBookmark,
  likeBookmark as dbLikeBookmark,
  getAllOwnTweets,
  setOwnTweetEmbedding,
  upsertOwnTweets,
} from "./db.js";
import { embedAllMissing, topRelated } from "./embeddings.js";
import { computeClusters, isSubstantive } from "./clusters.js";

const DEFAULT_K = 35;

let all = [];
let ownTweets = [];
let filtered = [];
let searchActive = false; // true whenever search/filters are set — bypasses topic browsing
// Tri-state per content type: "off" | "include" | "exclude". Cycled by clicking
// the top-filter chips; see applyFilters for how include/exclude combine.
const typeFilterState = { image: "off", video: "off", article: "off", link: "off" };
let clusters = null; // computed lazily, invalidated on new embeddings / K change
let selectedGroupKey = null; // which sidebar topic is open; null = landing state
let subClusters = null; // sub-topic breakdown of the currently selected group, if split
let subGroupParentKey = null; // which group `subClusters` belongs to
let selectedSubKey = null; // which sub-topic tile is open, within subClusters
let focusStack = []; // chain of records reached via "Related" clicks; last = shown card
const openRelatedPanels = new Set(); // refresh callbacks for currently-open "Related" panels
const SUB_CLUSTER_K = 5;
const SUB_CLUSTER_MIN_SIZE = 12; // below this, splitting isn't worth offering

// In-memory only, resets on reload — deleted records leave no trace to
// reconstruct a persistent count from anyway, and session-scoped progress
// ("how much have I cleaned up right now") is what's actually useful here,
// not a stored daily log.
let sessionArchived = 0;
let sessionDeleted = 0;

function updateSessionStats() {
  els.sessionStats.textContent = `This session: ${sessionArchived} archived, ${sessionDeleted} deleted`;
}

const els = {
  search: document.getElementById("search"),
  authorFilter: document.getElementById("authorFilter"),
  tagFilter: document.getElementById("tagFilter"),
  yearFilter: document.getElementById("yearFilter"),
  typeChips: [...document.querySelectorAll(".type-chip")],
  sidebar: document.getElementById("sidebar"),
  list: document.getElementById("list"),
  count: document.getElementById("count"),
  sessionStats: document.getElementById("sessionStats"),
  embedBtn: document.getElementById("embedBtn"),
  embedStatus: document.getElementById("embedStatus"),
  clusterK: document.getElementById("clusterK"),
  relatedMinScore: document.getElementById("relatedMinScore"),
  ownTweetStatus: document.getElementById("ownTweetStatus"),
  ownTweetEmbedBtn: document.getElementById("ownTweetEmbedBtn"),
  importOwnTweetsInput: document.getElementById("importOwnTweetsInput"),
};

async function load() {
  all = await getAllBookmarks();
  all.sort((a, b) => (b.capturedAt || "").localeCompare(a.capturedAt || ""));
  ownTweets = await getAllOwnTweets();
  populateFilters();
  applyFilters();
  updateEmbedStatus();
  updateOwnTweetStatus();
  updateSessionStats();
}

function updateEmbedStatus() {
  const embedded = all.filter((r) => r.embedding).length;
  els.embedStatus.textContent = `${embedded}/${all.length} embedded`;
  if (!els.clusterK.value) els.clusterK.value = DEFAULT_K;
}

function updateOwnTweetStatus() {
  const embedded = ownTweets.filter((r) => r.embedding).length;
  els.ownTweetStatus.textContent = `Own tweets: ${embedded}/${ownTweets.length} embedded`;
}

// Duplicated from parse.js rather than imported — see the OWN_HANDLE
// comment below for why (library.js and parse.js run in separate contexts
// that don't share module scope).
function decodeHtmlEntities(text) {
  return (text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// X's official data export ships each dataset as a .js file assigning a
// JSON array to window.YTD.<name>.partN — strip that assignment to get at
// the parseable JSON underneath.
function parseYtdFile(text) {
  const eq = text.indexOf("=");
  if (eq === -1) return null;
  try {
    return JSON.parse(text.slice(eq + 1).trim());
  } catch {
    return null;
  }
}

// Old-style retweets ("RT @user: ...") are someone else's words, not
// something this account holder wrote — excluded from the own-tweets
// corpus for the same reason db.js's STORE_OWN_TWEETS comment gives
// (scoring bookmarks against what *this person* has personally written).
const RT_PATTERN = /^RT @/;

// tweet.js's archive shape is a superset of what parse.js's own-tweets
// scraper captures live — only `id`/`text` are actually needed downstream
// (see isSubstantive/personalRelevance in clusters.js), so nothing from
// note-tweet.js (long-form overflow text) is joined in here yet.
function tweetsFromArchive(entries) {
  return (entries || [])
    .map((e) => e.tweet)
    .filter((t) => t?.id_str && t.full_text && !RT_PATTERN.test(t.full_text))
    .map((t) => ({
      id: t.id_str,
      text: decodeHtmlEntities(t.full_text),
      createdAt: t.created_at ? new Date(t.created_at).toISOString() : null,
      capturedAt: new Date().toISOString(),
    }));
}

async function importOwnTweetsFromArchive() {
  const files = [...els.importOwnTweetsInput.files];
  if (!files.length) return;
  els.ownTweetStatus.textContent = "Importing…";
  let inserted = 0;
  let updated = 0;
  let recognized = false;
  for (const file of files) {
    const text = await file.text();
    if (!/window\.YTD\.tweets\./.test(text)) continue; // only tweet.js is handled for now
    const entries = parseYtdFile(text);
    if (!Array.isArray(entries)) continue;
    recognized = true;
    const res = await upsertOwnTweets(tweetsFromArchive(entries));
    inserted += res.inserted;
    updated += res.updated;
  }
  els.importOwnTweetsInput.value = "";
  ownTweets = await getAllOwnTweets();
  updateOwnTweetStatus();
  clusters = null; // corpus changed — personal-relevance scores need recomputing
  resetDrillDown();
  render();
  alert(
    recognized
      ? `Imported ${inserted} new, updated ${updated} existing own tweets.`
      : "No tweets.js found in the selected file(s)."
  );
}

// Only tweets with an embedding, and enough real text to be a trustworthy
// reference (a thin/no-context tweet of yours shouldn't be eligible as an
// anchor — see isSubstantive), feed into personal-relevance scoring.
function ownTweetEmbeddings() {
  return ownTweets.filter((r) => r.embedding && isSubstantive(r.text)).map((r) => r.embedding);
}

let embedding = false;
let embedCancelled = false;

async function toggleEmbedding() {
  if (embedding) {
    embedCancelled = true;
    return;
  }
  embedding = true;
  embedCancelled = false;
  els.embedBtn.textContent = "Stop embedding";

  await embedAllMissing(all, {
    onModelProgress: (progress) => {
      if (progress?.status === "progress" && progress.total) {
        const pct = Math.round((progress.loaded / progress.total) * 100);
        els.embedStatus.textContent = `Downloading model… ${pct}%`;
      }
    },
    onItemProgress: (done, total) => {
      els.embedStatus.textContent = `Embedding ${done}/${total}…`;
      updateEmbedStatus();
    },
    isCancelled: () => embedCancelled,
    persist: (id, vec, model) => setEmbedding(id, vec, model),
  });

  embedding = false;
  els.embedBtn.textContent = "Compute embeddings";
  clusters = null; // new embeddings invalidate any cached grouping
  resetDrillDown(); // group contents/order may have shifted — back to landing state
  updateEmbedStatus();
  render();
}

function resetDrillDown() {
  selectedGroupKey = null;
  subClusters = null;
  subGroupParentKey = null;
  selectedSubKey = null;
  focusStack = [];
}

let ownTweetEmbedding = false;
let ownTweetEmbedCancelled = false;

async function toggleOwnTweetEmbedding() {
  if (ownTweetEmbedding) {
    ownTweetEmbedCancelled = true;
    return;
  }
  ownTweetEmbedding = true;
  ownTweetEmbedCancelled = false;
  els.ownTweetEmbedBtn.textContent = "Stop embedding";

  await embedAllMissing(ownTweets, {
    onModelProgress: (progress) => {
      if (progress?.status === "progress" && progress.total) {
        const pct = Math.round((progress.loaded / progress.total) * 100);
        els.ownTweetStatus.textContent = `Downloading model… ${pct}%`;
      }
    },
    onItemProgress: (done, total) => {
      els.ownTweetStatus.textContent = `Embedding ${done}/${total}…`;
      updateOwnTweetStatus();
    },
    isCancelled: () => ownTweetEmbedCancelled,
    persist: (id, vec, model) => setOwnTweetEmbedding(id, vec, model),
  });

  ownTweetEmbedding = false;
  els.ownTweetEmbedBtn.textContent = "Compute own-tweet embeddings";
  clusters = null; // representative picks depend on this corpus — recompute
  resetDrillDown();
  updateOwnTweetStatus();
  render();
}

els.embedBtn.addEventListener("click", toggleEmbedding);
els.ownTweetEmbedBtn.addEventListener("click", toggleOwnTweetEmbedding);
els.clusterK.addEventListener("change", () => {
  clusters = null;
  resetDrillDown();
  render();
});
els.relatedMinScore.addEventListener("change", () => {
  for (const refresh of openRelatedPanels) refresh();
});

function populateFilters() {
  const authors = [...new Set(all.map((r) => r.authorHandle))].sort();
  const tags = [...new Set(all.flatMap((r) => r.tags || []))].sort();
  const years = [...new Set(all.filter((r) => r.createdAt).map((r) => new Date(r.createdAt).getFullYear()))].sort(
    (a, b) => b - a
  );
  const prevAuthor = els.authorFilter.value;
  const prevTag = els.tagFilter.value;
  const prevYear = els.yearFilter.value;

  els.authorFilter.innerHTML =
    '<option value="">All authors</option>' +
    authors.map((a) => `<option value="${a}">@${a}</option>`).join("");
  els.tagFilter.innerHTML =
    '<option value="">All tags</option>' + tags.map((t) => `<option value="${t}">${t}</option>`).join("");
  els.yearFilter.innerHTML =
    '<option value="">Any age</option>' + years.map((y) => `<option value="${y}">${y}</option>`).join("");

  els.authorFilter.value = prevAuthor;
  els.tagFilter.value = prevTag;
  els.yearFilter.value = prevYear;
}

function applyFilters() {
  const q = els.search.value.trim().toLowerCase();
  const author = els.authorFilter.value;
  const tag = els.tagFilter.value;
  const year = els.yearFilter.value;
  const includeTypes = Object.keys(typeFilterState).filter((t) => typeFilterState[t] === "include");
  const excludeTypes = Object.keys(typeFilterState).filter((t) => typeFilterState[t] === "exclude");
  const anyTypeFilter = includeTypes.length > 0 || excludeTypes.length > 0;
  searchActive = !!(q || author || tag || year || anyTypeFilter);

  filtered = all.filter((r) => {
    if (author && r.authorHandle !== author) return false;
    if (tag && !(r.tags || []).includes(tag)) return false;
    if (year && (!r.createdAt || new Date(r.createdAt).getFullYear() !== Number(year))) return false;
    if (excludeTypes.some((t) => TYPE_PREDICATES[t](r))) return false;
    if (includeTypes.length && !includeTypes.some((t) => TYPE_PREDICATES[t](r))) return false;
    if (q) {
      const hay = `${r.text} ${r.authorHandle} ${r.authorName} ${(r.tags || []).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  render();
}

function clearSearchAndFilters() {
  els.search.value = "";
  els.authorFilter.value = "";
  els.tagFilter.value = "";
  els.yearFilter.value = "";
  for (const chip of els.typeChips) {
    typeFilterState[chip.dataset.type] = "off";
    chip.dataset.state = "off";
  }
  focusStack = []; // real navigation (e.g. sidebar click) exits single-card focus mode
  applyFilters();
}

// Wraps applyFilters for the raw search/filter inputs specifically — typing
// a search or changing a filter should exit focus mode, but not every
// applyFilters() caller wants that (deleteBookmark needs finer control, so
// it can trim just the deleted entry from the stack instead of wiping it).
function applyFiltersFromInput() {
  focusStack = [];
  applyFilters();
}

// Real topic groups + a catch-all "Unsorted" bucket for anything not yet
// embedded, so nothing is invisible from the sidebar. Real clusters are
// keyed by index into the cached `clusters` array so selection survives
// re-renders that don't invalidate it (filter changes, tag edits, etc).
function getGroups() {
  const embedded = all.filter((r) => r.embedding);
  let realClusters = [];
  if (embedded.length >= 2) {
    clusters ??= computeClusters(embedded, Number(els.clusterK.value) || DEFAULT_K, ownTweetEmbeddings());
    realClusters = clusters;
  }
  const clusteredIds = new Set(realClusters.flatMap((g) => g.members.map((r) => r.id)));
  const unsortedMembers = all.filter((r) => !clusteredIds.has(r.id));
  const groups = realClusters.map((g, i) => ({
    key: `cluster-${i}`,
    label: g.label,
    members: g.members,
    centralId: g.centralId,
    scores: g.scores,
  }));
  if (unsortedMembers.length) {
    groups.push({ key: "unsorted", label: "Unsorted", members: unsortedMembers, unsorted: true });
  }
  return groups;
}

function renderSidebar(groups) {
  els.sidebar.innerHTML = "";
  for (const g of groups) {
    const btn = document.createElement("button");
    btn.className =
      "sidebar-item" + (g.unsorted ? " unsorted" : "") + (g.key === selectedGroupKey ? " active" : "");
    btn.innerHTML = `<span>${g.label}</span><span class="sidebar-count">${g.members.length}</span>`;
    btn.addEventListener("click", () => selectGroup(g.key));
    els.sidebar.appendChild(btn);
  }
}

function selectGroup(key) {
  selectedGroupKey = key;
  subClusters = null;
  subGroupParentKey = null;
  selectedSubKey = null;
  clearSearchAndFilters();
}

// "X / Y bookmarks" only makes sense once a filter is actually narrowing
// things — with none active, filtered === all, so showing the same number
// twice is just noise. Unfiltered, show the bookmarked/archived split
// instead (mutually exclusive — archivedFromX is only ever set by Archive).
function countsLabel() {
  if (searchActive) return `${filtered.length} / ${all.length} bookmarks`;
  const archivedCount = all.filter((r) => r.archivedFromX).length;
  return `${all.length - archivedCount} bookmarked · ${archivedCount} archived`;
}

function render() {
  els.count.textContent = countsLabel();
  const groups = getGroups();
  renderSidebar(groups);
  els.list.innerHTML = "";
  openRelatedPanels.clear(); // old panels' DOM is about to be discarded

  if (focusStack.length) {
    renderFocused();
    return;
  }

  if (searchActive) {
    if (!filtered.length) {
      els.list.innerHTML = `<div class="browse-hint">No matches.</div>`;
      return;
    }
    appendCardColumns(filtered);
    return;
  }

  const group = groups.find((g) => g.key === selectedGroupKey);
  if (!group) {
    renderLanding(groups);
    return;
  }
  renderGroupView(group);
}

const LANDING_TOP_N = 3;

// Must match OWN_HANDLE in parse.js — duplicated, not imported, since
// library.js (extension page) and parse.js (content script) run in
// separate contexts that don't share module scope.
const OWN_HANDLE = "vinnygarr";

// Top picks across the whole library by relevance score, as-is — no
// recompute, just reusing each group's already-computed `scores` (personal
// relevance is an absolute score, comparable across topics, unlike the old
// in-cluster centrality metric). "Unsorted" has no scores at all and is
// naturally excluded by that. Your own bookmarked tweets are excluded too —
// they trivially score near-perfect similarity against your own corpus,
// which isn't a meaningful "pick." Archived tweets are excluded from picks
// specifically (already cleaned up, no need to resurface) but stay fully
// part of their cluster/topic view — this filter doesn't touch getGroups.
function renderLanding(groups) {
  const ranked = groups
    .filter((g) => g.scores)
    .flatMap((g) => g.members.filter((r) => g.scores.has(r.id)).map((r) => ({ r, score: g.scores.get(r.id) })))
    .filter(({ r }) => r.authorHandle.toLowerCase() !== OWN_HANDLE && !r.archivedFromX)
    .sort((a, b) => b.score - a.score)
    .slice(0, LANDING_TOP_N);

  if (!ranked.length) {
    els.list.innerHTML = `<div class="browse-hint">Select a topic on the left, or search above.</div>`;
    return;
  }

  const intro = document.createElement("div");
  intro.className = "browse-hint";
  intro.textContent = "Top picks — or select a topic on the left, or search above.";
  els.list.appendChild(intro);
  const scoreById = new Map(ranked.map(({ r, score }) => [r.id, score]));
  appendCardColumns(
    ranked.map(({ r }) => r),
    (r) => scoreById.get(r.id)
  );
}

// Cards flow into a dedicated multi-column wrapper (real masonry packing —
// see .card-columns in library.css) rather than directly into #list, which
// also holds header/breadcrumb elements that need to stay full-width above
// the cards instead of getting sucked into the column flow.
function appendCardColumns(records, scoreFn) {
  const wrapper = document.createElement("div");
  wrapper.className = "card-columns";
  for (const r of records) wrapper.appendChild(renderCard(r, scoreFn?.(r)));
  els.list.appendChild(wrapper);
}

function crumbHeader(backLabel, currentLabel, onBack) {
  const header = document.createElement("div");
  header.className = "group-header";
  const backBtn = document.createElement("button");
  backBtn.className = "crumb-back";
  backBtn.textContent = `← ${backLabel}`;
  backBtn.addEventListener("click", onBack);
  header.appendChild(backBtn);
  if (currentLabel) {
    const current = document.createElement("span");
    current.className = "crumb-current";
    current.textContent = currentLabel;
    header.appendChild(current);
  }
  return header;
}

function renderGroupView(group) {
  // Already split into sub-topics for this group.
  if (subClusters && subGroupParentKey === group.key) {
    const subGroup = subClusters.find((sg) => sg.key === selectedSubKey);

    if (subGroup) {
      els.list.appendChild(
        crumbHeader(group.label, subGroup.label, () => {
          selectedSubKey = null;
          render();
        })
      );
      appendCardColumns(subGroup.members);
      return;
    }

    els.list.appendChild(
      crumbHeader(group.label, "Sub-topics", () => {
        subClusters = null;
        subGroupParentKey = null;
        render();
      })
    );
    const grid = document.createElement("div");
    grid.className = "subtile-grid";
    for (const sg of subClusters) {
      const tile = document.createElement("button");
      tile.className = "subtile";
      tile.innerHTML = `<span>${sg.label}</span><span class="sidebar-count">${sg.members.length}</span>`;
      tile.addEventListener("click", () => {
        selectedSubKey = sg.key;
        render();
      });
      grid.appendChild(tile);
    }
    els.list.appendChild(grid);
    return;
  }

  // Flat view of the group, with an option to split it further.
  const header = document.createElement("div");
  header.className = "group-header";
  header.innerHTML = `<h2>${group.label}</h2><span class="cluster-count">${group.members.length}</span>`;
  if (!group.unsorted && group.members.length >= SUB_CLUSTER_MIN_SIZE) {
    const splitBtn = document.createElement("button");
    splitBtn.className = "split-btn";
    splitBtn.textContent = "Split into sub-topics";
    splitBtn.addEventListener("click", () => {
      subClusters = computeClusters(group.members, SUB_CLUSTER_K, ownTweetEmbeddings()).map((sg, i) => ({
        key: `sub-${i}`,
        label: sg.label,
        members: sg.members,
      }));
      subGroupParentKey = group.key;
      selectedSubKey = null;
      render();
    });
    header.appendChild(splitBtn);
  }
  els.list.appendChild(header);
  const members = group.scores
    ? [...group.members].sort((a, b) => group.scores.get(b.id) - group.scores.get(a.id))
    : group.members;
  appendCardColumns(members, group.scores ? (r) => group.scores.get(r.id) : undefined);
}

// Full trail of authors reached via "Related" clicks (@A › @B › @C › @D),
// not just a single "← Back" — each prior segment jumps back to that point
// in the chain; a leading "← Back" exits focus mode entirely.
function renderFocused() {
  const header = document.createElement("div");
  header.className = "group-header";

  const backBtn = document.createElement("button");
  backBtn.className = "crumb-back";
  backBtn.textContent = "← Back";
  backBtn.addEventListener("click", () => {
    focusStack = [];
    render();
  });
  header.appendChild(backBtn);

  focusStack.forEach((r, i) => {
    const sep = document.createElement("span");
    sep.className = "crumb-current";
    sep.textContent = " › ";
    header.appendChild(sep);

    const isLast = i === focusStack.length - 1;
    const seg = document.createElement(isLast ? "span" : "button");
    seg.className = isLast ? "crumb-current" : "crumb-back";
    seg.textContent = `@${r.authorHandle}`;
    if (!isLast) {
      seg.addEventListener("click", () => {
        focusStack = focusStack.slice(0, i + 1);
        render();
      });
    }
    header.appendChild(seg);
  });

  els.list.appendChild(header);
  appendCardColumns([focusStack[focusStack.length - 1]]);
}

function escapeHtml(text) {
  return (text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Escape first, then linkify — the inserted <a> tags must not themselves
// get escaped, and URLs don't contain the characters escapeHtml touches.
function linkifyText(text) {
  return escapeHtml(text).replace(
    /(https?:\/\/\S+)/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`
  );
}

// extractMediaUrls (parse.js) resolves video/animated_gif entries to their
// .mp4 variant URL — that's a reliable enough signal to tell video apart
// from photo purely from the URL, without needing a schema change (works
// retroactively on already-captured data too, not just new captures).
const VIDEO_URL_PATTERN = /\.mp4(\?|$)/i;

function renderMediaItem(url) {
  return VIDEO_URL_PATTERN.test(url)
    ? `<video src="${url}" controls></video>`
    : `<img src="${url}">`;
}

// Shared by contentBadges and the top-filter chips — video/image are
// derived from mediaUrls rather than stored separately (same
// VIDEO_URL_PATTERN used for rendering the media itself).
function hasVideo(r) {
  return (r.mediaUrls || []).some((u) => VIDEO_URL_PATTERN.test(u));
}
function hasImage(r) {
  return (r.mediaUrls || []).some((u) => !VIDEO_URL_PATTERN.test(u));
}
function hasLink(r) {
  return (r.externalLinks || []).length > 0;
}

const TYPE_PREDICATES = {
  image: hasImage,
  video: hasVideo,
  article: (r) => r.hasArticle,
  link: hasLink,
};

function cycleTypeChip(chip) {
  const type = chip.dataset.type;
  const next = { off: "include", include: "exclude", exclude: "off" }[typeFilterState[type]];
  typeFilterState[type] = next;
  chip.dataset.state = next;
}

// Cheap content-type badges — article/quote come from flags parse.js
// already computed at capture time. A post with both photo and video media
// only shows "Video" here to keep the badge row short, but the type filter
// treats them as independent (see applyFilters).
function contentBadges(r) {
  const badges = [];
  if (r.hasArticle) badges.push("X Article");
  if (r.isQuote) badges.push("Quote");
  if (hasVideo(r)) badges.push("Video");
  else if (hasImage(r)) badges.push("Image");
  if (hasLink(r)) badges.push("Link");
  return badges;
}

function renderCard(r, score) {
  const card = document.createElement("div");
  card.className = "card";
  const badges = contentBadges(r);
  card.innerHTML = `
    <div class="card-header">
      <img src="${r.authorAvatar || ""}" alt="" class="avatar">
      <div>
        <div class="name"></div>
        <div class="handle"></div>
      </div>
      <a class="date" href="${r.url}" target="_blank" rel="noopener">${
    r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ""
  }</a>
    </div>
    ${typeof score === "number" ? `<div class="relevance-score">Relevance: ${score.toFixed(3)}</div>` : ""}
    ${
      badges.length
        ? `<div class="content-badges">${badges.map((b) => `<span class="content-badge">[${b}]</span>`).join("")}</div>`
        : ""
    }
    <div class="text"></div>
    ${
      (r.mediaUrls || []).length
        ? `<div class="media">${r.mediaUrls.map(renderMediaItem).join("")}</div>`
        : ""
    }
    <div class="stats">♥ ${r.likeCount} · ↺ ${r.retweetCount} · ↩ ${r.replyCount}</div>
    <div class="tags"></div>
    <input class="tag-input" placeholder="Add tag and press Enter">
    <textarea class="note-input" placeholder="Notes…"></textarea>
    <div class="archived-badge" hidden>Archived from X</div>
    <div class="liked-badge" hidden>Liked on X</div>
    <div class="card-actions">
      <a class="view-on-x" href="${r.url}" target="_blank" rel="noopener">View on X</a>
      <button class="related-toggle">Related</button>
      <button class="like-btn">Like</button>
      <button class="archive-btn">Archive</button>
      <button class="delete-btn">Delete</button>
    </div>
    <div class="related-list"></div>
  `;
  card.querySelector(".name").textContent = r.authorName;
  card.querySelector(".handle").textContent = `@${r.authorHandle}`;
  card.querySelector(".text").innerHTML = linkifyText(r.text);
  card.querySelector(".note-input").value = r.note || "";

  const tagsEl = card.querySelector(".tags");
  function renderTags() {
    tagsEl.innerHTML = "";
    for (const t of r.tags || []) {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.textContent = t;
      chip.title = "Click to remove";
      chip.addEventListener("click", async () => {
        r.tags = (r.tags || []).filter((x) => x !== t);
        await updateBookmarkMeta(r.id, { tags: r.tags });
        renderTags();
        populateFilters();
      });
      tagsEl.appendChild(chip);
    }
  }
  renderTags();

  const tagInput = card.querySelector(".tag-input");
  tagInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || !tagInput.value.trim()) return;
    const t = tagInput.value.trim();
    tagInput.value = "";
    r.tags = [...new Set([...(r.tags || []), t])];
    await updateBookmarkMeta(r.id, { tags: r.tags });
    renderTags();
    populateFilters();
  });

  const noteInput = card.querySelector(".note-input");
  let noteTimer;
  noteInput.addEventListener("input", () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
      r.note = noteInput.value;
      await updateBookmarkMeta(r.id, { note: r.note });
    }, 500);
  });

  const relatedBtn = card.querySelector(".related-toggle");
  const relatedList = card.querySelector(".related-list");
  if (!r.embedding) {
    relatedBtn.disabled = true;
    relatedBtn.title = "Compute embeddings first";
  }
  let relatedShown = false;
  function refreshRelated() {
    // Recomputed fresh (not cached) since the threshold is a live,
    // user-adjustable control — cheap enough at personal-library scale.
    const minScore = Number(els.relatedMinScore.value) || 0;
    // Exclude anything already in the breadcrumb trail (A > B > C shouldn't
    // suggest A or B again from C) — a no-op when not in focus mode, since
    // focusStack is empty there.
    const breadcrumbIds = new Set(focusStack.map((x) => x.id));
    const candidates = breadcrumbIds.size ? all.filter((x) => !breadcrumbIds.has(x.id)) : all;
    const results = topRelated(r, candidates, 5, minScore);
    relatedList.innerHTML = results.length
      ? results
          .map(
            ({ record, score }) => `
        <button class="related-item" data-id="${record.id}">
          <span class="related-score">${score.toFixed(2)}</span>
          <span class="related-author">@${record.authorHandle}</span>
          <span class="related-text">${record.text.replace(/</g, "&lt;")}</span>
        </button>`
          )
          .join("")
      : `<div class="related-item related-empty">No related tweets found</div>`;
    // Clicking a related tweet focuses it in the library (so you can keep
    // browsing via its own Related panel) rather than just linking to X.
    relatedList.querySelectorAll(".related-item[data-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const target = all.find((x) => x.id === el.dataset.id);
        if (target) {
          // First hop from a non-focused view (topic/search) — the card you
          // clicked Related *from* becomes the root of the breadcrumb, not
          // just the target. Already-focused hops don't re-push r, since
          // it's already the stack's current top.
          if (!focusStack.length) focusStack.push(r);
          focusStack.push(target);
          render();
        }
      });
    });
  }
  relatedBtn.addEventListener("click", () => {
    relatedShown = !relatedShown;
    if (!relatedShown) {
      relatedList.innerHTML = "";
      openRelatedPanels.delete(refreshRelated);
      return;
    }
    refreshRelated();
    openRelatedPanels.add(refreshRelated);
  });

  const deleteBtn = card.querySelector(".delete-btn");
  deleteBtn.addEventListener("click", () => deleteBookmark(r));

  const likeBtn = card.querySelector(".like-btn");
  const likedBadge = card.querySelector(".liked-badge");
  if (r.likedOnX) {
    likedBadge.hidden = false;
    likeBtn.disabled = true;
  }
  likeBtn.addEventListener("click", async () => {
    if (r.likedOnX) return;
    const ok = await likeTweet(r);
    if (!ok) return;
    likedBadge.hidden = false;
    likeBtn.disabled = true;
  });

  const archiveBtn = card.querySelector(".archive-btn");
  const archivedBadge = card.querySelector(".archived-badge");
  if (r.archivedFromX) {
    archivedBadge.hidden = false;
    archiveBtn.disabled = true;
  }
  archiveBtn.addEventListener("click", async () => {
    if (r.archivedFromX) return;
    const ok = await archiveBookmark(r);
    if (!ok) return;
    archivedBadge.hidden = false;
    archiveBtn.disabled = true;
  });

  return card;
}

// Removes the bookmark from X (same unbookmark mutation as deleteBookmark)
// but keeps the local record — so X's bookmark list can be pruned over
// time without losing anything from the library. Stays visible wherever
// it already is (its cluster/tags/embedding are untouched), just flagged.
// Returns whether it actually succeeded, so the caller only updates the UI
// on a real success (not a cancelled confirm or a failed X call).
async function archiveBookmark(r) {
  if (!confirm(`Remove this from X's bookmarks but keep it in your library?\n\n${r.text.slice(0, 100)}`)) {
    return false;
  }

  const res = await chrome.runtime.sendMessage({ type: "DELETE_BOOKMARK", tweetId: r.id });
  if (!res?.ok) {
    alert(`Failed to remove from X: ${res?.error || "unknown error"}`);
    return false;
  }

  await dbArchiveBookmark(r.id);
  r.archivedFromX = true;
  r.archivedAt = new Date().toISOString();
  sessionArchived++;
  updateSessionStats();
  return true;
}

// Likes the post on X (signals its relevance to X's feed algorithm) and
// flags it locally — one-way, no unlike from the extension. Returns
// whether it actually succeeded, so the caller only updates the UI on a
// real success.
async function likeTweet(r) {
  const res = await chrome.runtime.sendMessage({ type: "LIKE_TWEET", tweetId: r.id });
  if (!res?.ok) {
    alert(`Failed to like on X: ${res?.error || "unknown error"}`);
    return false;
  }

  await dbLikeBookmark(r.id);
  r.likedOnX = true;
  r.likedAt = new Date().toISOString();
  return true;
}

async function deleteBookmark(r) {
  if (!confirm(`Delete this from X and your library?\n\n${r.text.slice(0, 100)}`)) return;

  const res = await chrome.runtime.sendMessage({ type: "DELETE_BOOKMARK", tweetId: r.id });
  if (!res?.ok) {
    alert(`Failed to delete on X: ${res?.error || "unknown error"}`);
    return;
  }

  await dbDeleteBookmark(r.id);
  all = all.filter((x) => x.id !== r.id);
  // Surgically drop it from the cached grouping instead of invalidating
  // `clusters` outright — a full recompute would reshuffle everything and
  // reset the sidebar selection just because one card disappeared.
  if (clusters) {
    for (const g of clusters) g.members = g.members.filter((x) => x.id !== r.id);
  }
  // Sub-cluster membership isn't worth the same surgical treatment for a
  // single delete — just drop back to the flat topic view.
  subClusters = null;
  subGroupParentKey = null;
  selectedSubKey = null;
  // Only the deleted card itself can be showing while focused (it's always
  // the last entry — see renderFocused) — pop just that, so the rest of the
  // breadcrumb trail survives instead of the whole chain being discarded.
  if (focusStack.length && focusStack[focusStack.length - 1].id === r.id) {
    focusStack.pop();
  }
  sessionDeleted++;
  updateSessionStats();
  applyFilters();
}

els.search.addEventListener("input", applyFiltersFromInput);
els.authorFilter.addEventListener("change", applyFiltersFromInput);
els.tagFilter.addEventListener("change", applyFiltersFromInput);
els.yearFilter.addEventListener("change", applyFiltersFromInput);
for (const chip of els.typeChips) {
  chip.addEventListener("click", () => {
    cycleTypeChip(chip);
    applyFiltersFromInput();
  });
}
els.importOwnTweetsInput.addEventListener("change", importOwnTweetsFromArchive);

load();
