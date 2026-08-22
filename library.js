import { getAllBookmarks, updateBookmarkMeta } from "./db.js";

let all = [];
let filtered = [];

const els = {
  search: document.getElementById("search"),
  authorFilter: document.getElementById("authorFilter"),
  tagFilter: document.getElementById("tagFilter"),
  mediaOnly: document.getElementById("mediaOnly"),
  list: document.getElementById("list"),
  count: document.getElementById("count"),
};

async function load() {
  all = await getAllBookmarks();
  all.sort((a, b) => (b.capturedAt || "").localeCompare(a.capturedAt || ""));
  populateFilters();
  applyFilters();
}

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
  const q = els.search.value.trim().toLowerCase();
  const author = els.authorFilter.value;
  const tag = els.tagFilter.value;
  const mediaOnly = els.mediaOnly.checked;

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

function render() {
  els.count.textContent = `${filtered.length} / ${all.length} bookmarks`;
  els.list.innerHTML = "";
  for (const r of filtered) {
    els.list.appendChild(renderCard(r));
  }
}

function renderCard(r) {
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

  return card;
}

els.search.addEventListener("input", applyFilters);
els.authorFilter.addEventListener("change", applyFilters);
els.tagFilter.addEventListener("change", applyFilters);
els.mediaOnly.addEventListener("change", applyFilters);

load();
