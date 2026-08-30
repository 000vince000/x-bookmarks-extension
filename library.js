import {
  getAllBookmarks,
  updateBookmarkMeta,
  setEmbedding,
  deleteBookmark as dbDeleteBookmark,
  getAllOwnTweets,
  setOwnTweetEmbedding,
} from "./db.js";
import { embedAllMissing, topRelated } from "./embeddings.js";
import { computeClusters } from "./clusters.js";

const DEFAULT_K = 35;

let all = [];
let ownTweets = [];
let filtered = [];
let searchActive = false; // true whenever search/filters are set — bypasses topic browsing
let clusters = null; // computed lazily, invalidated on new embeddings / K change
let selectedGroupKey = null; // which sidebar topic is open; null = landing state
let subClusters = null; // sub-topic breakdown of the currently selected group, if split
let subGroupParentKey = null; // which group `subClusters` belongs to
let selectedSubKey = null; // which sub-topic tile is open, within subClusters
let focusedRecord = null; // single-card view entered via clicking a Related item
const openRelatedPanels = new Set(); // refresh callbacks for currently-open "Related" panels
const SUB_CLUSTER_K = 5;
const SUB_CLUSTER_MIN_SIZE = 12; // below this, splitting isn't worth offering

const els = {
  search: document.getElementById("search"),
  authorFilter: document.getElementById("authorFilter"),
  tagFilter: document.getElementById("tagFilter"),
  mediaOnly: document.getElementById("mediaOnly"),
  sidebar: document.getElementById("sidebar"),
  list: document.getElementById("list"),
  count: document.getElementById("count"),
  embedBtn: document.getElementById("embedBtn"),
  embedStatus: document.getElementById("embedStatus"),
  clusterK: document.getElementById("clusterK"),
  relatedMinScore: document.getElementById("relatedMinScore"),
  ownTweetStatus: document.getElementById("ownTweetStatus"),
  ownTweetEmbedBtn: document.getElementById("ownTweetEmbedBtn"),
};

async function load() {
  all = await getAllBookmarks();
  all.sort((a, b) => (b.capturedAt || "").localeCompare(a.capturedAt || ""));
  ownTweets = await getAllOwnTweets();
  populateFilters();
  applyFilters();
  updateEmbedStatus();
  updateOwnTweetStatus();
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

// Only tweets with an embedding are usable as a personal-relevance
// reference — passed into computeClusters wherever it's called.
function ownTweetEmbeddings() {
  return ownTweets.filter((r) => r.embedding).map((r) => r.embedding);
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
  focusedRecord = null;
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
  const prevAuthor = els.authorFilter.value;
  const prevTag = els.tagFilter.value;

  els.authorFilter.innerHTML =
    '<option value="">All authors</option>' +
    authors.map((a) => `<option value="${a}">@${a}</option>`).join("");
  els.tagFilter.innerHTML =
    '<option value="">All tags</option>' + tags.map((t) => `<option value="${t}">${t}</option>`).join("");

  els.authorFilter.value = prevAuthor;
  els.tagFilter.value = prevTag;
}

function applyFilters() {
  focusedRecord = null; // any real navigation action exits single-card focus mode
  const q = els.search.value.trim().toLowerCase();
  const author = els.authorFilter.value;
  const tag = els.tagFilter.value;
  const mediaOnly = els.mediaOnly.checked;
  searchActive = !!(q || author || tag || mediaOnly);

  filtered = all.filter((r) => {
    if (author && r.authorHandle !== author) return false;
    if (tag && !(r.tags || []).includes(tag)) return false;
    if (mediaOnly && !(r.mediaUrls || []).length) return false;
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
  els.mediaOnly.checked = false;
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

function render() {
  els.count.textContent = `${filtered.length} / ${all.length} bookmarks`;
  const groups = getGroups();
  renderSidebar(groups);
  els.list.innerHTML = "";
  openRelatedPanels.clear(); // old panels' DOM is about to be discarded

  if (focusedRecord) {
    renderFocused();
    return;
  }

  if (searchActive) {
    if (!filtered.length) {
      els.list.innerHTML = `<div class="browse-hint">No matches.</div>`;
      return;
    }
    for (const r of filtered) els.list.appendChild(renderCard(r));
    return;
  }

  const group = groups.find((g) => g.key === selectedGroupKey);
  if (!group) {
    els.list.innerHTML = `<div class="browse-hint">Select a topic on the left, or search above.</div>`;
    return;
  }
  renderGroupView(group);
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
      for (const r of subGroup.members) els.list.appendChild(renderCard(r));
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
  for (const r of members) els.list.appendChild(renderCard(r, group.scores?.get(r.id)));
}

function renderFocused() {
  els.list.appendChild(
    crumbHeader("Back", "", () => {
      focusedRecord = null;
      render();
    })
  );
  els.list.appendChild(renderCard(focusedRecord));
}

function renderCard(r, score) {
  const card = document.createElement("div");
  card.className = "card";
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
    <div class="text"></div>
    ${
      (r.mediaUrls || []).length
        ? `<div class="media">${r.mediaUrls.map((u) => `<img src="${u}">`).join("")}</div>`
        : ""
    }
    <div class="stats">♥ ${r.likeCount} · ↺ ${r.retweetCount} · ↩ ${r.replyCount}</div>
    <div class="tags"></div>
    <input class="tag-input" placeholder="Add tag and press Enter">
    <textarea class="note-input" placeholder="Notes…"></textarea>
    <div class="card-actions">
      <button class="related-toggle">Related</button>
      <button class="delete-btn">Delete</button>
    </div>
    <div class="related-list"></div>
  `;
  card.querySelector(".name").textContent = r.authorName;
  card.querySelector(".handle").textContent = `@${r.authorHandle}`;
  card.querySelector(".text").textContent = r.text;
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
    const results = topRelated(r, all, 5, minScore);
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
          focusedRecord = target;
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

  return card;
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
  // single delete — just drop back to the flat topic view. applyFilters()
  // below also clears focusedRecord unconditionally, exiting focus mode if
  // the deleted card was the one being viewed.
  subClusters = null;
  subGroupParentKey = null;
  selectedSubKey = null;
  applyFilters();
}

els.search.addEventListener("input", applyFilters);
els.authorFilter.addEventListener("change", applyFilters);
els.tagFilter.addEventListener("change", applyFilters);
els.mediaOnly.addEventListener("change", applyFilters);

load();
