import { getAllBookmarks, getAllResearchPosts, setResearchPostStatus } from "./db.js";

const WATCHLIST_KEY = "researchWatchlist";
const QUALITY_THRESHOLD_KEY = "researchQualityThreshold";
const DEFAULT_WATCHLIST = `# Label | X search query
TSM | ($TSM OR TSMC) lang:en -filter:replies
UBER | ($UBER OR "Uber Technologies") lang:en -filter:replies
PAVE | ($PAVE OR "US infrastructure") lang:en -filter:replies
MPLX | ($MPLX OR "MPLX LP") lang:en -filter:replies
NEM | ($NEM OR Newmont) lang:en -filter:replies
ABBV | ($ABBV OR AbbVie) lang:en -filter:replies
BRK.B | ($BRK.B OR Berkshire) lang:en -filter:replies
FLKR | ($FLKR OR $EWY OR EWY OR "South Korea equities") lang:en -filter:replies
FLLA | ($FLLA OR "Latin America equities") lang:en -filter:replies
IEFA | ($IEFA OR "developed markets ex US") lang:en -filter:replies
IAU | ($IAU OR "gold price") lang:en -filter:replies`;

const els = {
  watchlist: document.getElementById("watchlist"),
  watchlistStatus: document.getElementById("watchlistStatus"),
  scanBtn: document.getElementById("scanBtn"),
  stopBtn: document.getElementById("stopBtn"),
  scanStatus: document.getElementById("scanStatus"),
  feedSearch: document.getElementById("feedSearch"),
  statusFilter: document.getElementById("statusFilter"),
  labelFilter: document.getElementById("labelFilter"),
  sortBy: document.getElementById("sortBy"),
  qualityThreshold: document.getElementById("qualityThreshold"),
  feedCount: document.getElementById("feedCount"),
  feed: document.getElementById("feed"),
};

let posts = [];
let savedAuthorCounts = new Map();
let refreshTimer = null;

const TECHNICAL_OR_SHORT_TERM_PATTERN = new RegExp(
  [
    "technical analysis", "price action", "price target", "support level", "resistance level",
    "breakout", "breakdown", "oversold", "overbought", "rsi", "macd", "moving average",
    "golden cross", "death cross", "stop loss", "entry point", "take profit", "candlestick",
    "trendline", "fibonacci", "premarket", "intraday", "day trade", "swing trade", "gamma squeeze",
    "calls? flow", "puts? flow",
  ].join("|"),
  "i"
);
const TICKER_PATTERN = /\$[A-Z]{1,6}(?:\.[A-Z])?/gi;

function parseWatchlist(text) {
  const jobs = [];
  const errors = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("|");
    if (separator < 1 || !line.slice(separator + 1).trim()) {
      errors.push(`line ${index + 1}`);
      continue;
    }
    const label = line.slice(0, separator).trim();
    const query = line.slice(separator + 1).trim();
    jobs.push({ id: `${index}-${label}`, label, query });
  }
  return { jobs, errors };
}

// Applies explicit portfolio-watchlist changes to an already-saved starter
// list without replacing unrelated searches the owner may have added.
function migrateWatchlist(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*VOO\s*\|/i.test(line))
    .map((line) => {
      if (!/^\s*FLKR\s*\|/i.test(line) || /\bEWY\b/i.test(line)) return line;
      return line.replace(/\$FLKR\b/i, "$FLKR OR $EWY OR EWY");
    })
    .join("\n");
}

function scorePost(post) {
  const reasons = [];
  const gateReasons = [];
  let score = 0;
  const text = post.text || "";
  const ageHours = Math.max(1, (Date.now() - new Date(post.createdAt || Date.now()).getTime()) / 36e5);
  const engagement = (post.likeCount || 0) + 2 * (post.retweetCount || 0) + (post.replyCount || 0);
  const velocity = engagement / Math.sqrt(ageHours);

  const substance = Math.min(20, (text.length / 500) * 20);
  score += substance;
  if (substance >= 12) reasons.push("substantive");

  const engagementScore = Math.min(25, Math.log10(1 + velocity) * 11);
  score += engagementScore;
  if (engagementScore >= 10) reasons.push("engaged");

  const savedCount = savedAuthorCounts.get((post.authorHandle || "").toLowerCase()) || 0;
  if (savedCount) {
    score += Math.min(20, 6 * Math.sqrt(savedCount));
    reasons.push(`saved author ×${savedCount}`);
  }

  if ((post.externalLinks || []).length) {
    score += 10;
    reasons.push("cites a link");
  }
  if ((post.mediaUrls || []).length) {
    score += 4;
    reasons.push("visual evidence");
  }
  if (/\b\d+(?:\.\d+)?%|\$\d|\b(revenue|margin|yield|guidance|filing|source|data|chart|estimate|capacity)\b/i.test(text)) {
    score += 9;
    reasons.push("specific evidence");
  }
  if (/🧵|\bthread\b|(^|\s)1\//i.test(text)) {
    score += 4;
    reasons.push("thread");
  }
  if (/\b(guaranteed|can't lose|moon|multibagger|load up|easy money|buy now)\b/i.test(text)) {
    score -= 18;
    reasons.push("promotional language");
  }
  if (text.length < 60) score -= 12;
  if (/^RT @/.test(text)) score -= 8;

  const tickers = new Set((text.match(TICKER_PATTERN) || []).map((ticker) => ticker.toUpperCase()));
  if (tickers.size > 1) {
    score -= Math.min(28, (tickers.size - 1) * 7);
    reasons.push(`${tickers.size} tickers`);
  }
  if (tickers.size >= 4) gateReasons.push(`ticker roundup (${tickers.size} cashtags)`);
  if (TECHNICAL_OR_SHORT_TERM_PATTERN.test(text)) gateReasons.push("short-term price/technical analysis");

  const boundedScore = Math.max(0, Math.min(100, Math.round(score)));
  const threshold = Number(els.qualityThreshold.value) || 0;
  if (boundedScore < threshold) gateReasons.push(`quality below ${threshold}`);
  return { score: boundedScore, reasons, gateReasons, passesGate: gateReasons.length === 0 };
}

function totalEngagement(post) {
  return (post.likeCount || 0) + (post.retweetCount || 0) + (post.replyCount || 0);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMedia(post) {
  if (!(post.mediaUrls || []).length) return "";
  const items = post.mediaUrls
    .slice(0, 4)
    .map((url) =>
      /\.mp4(?:\?|$)/i.test(url)
        ? `<video src="${escapeHtml(url)}" controls></video>`
        : `<img src="${escapeHtml(url)}" alt="">`
    )
    .join("");
  return `<div class="media">${items}</div>`;
}

function researchMarkdown(post) {
  const labels = [...new Set((post.researchMatches || []).map((m) => m.label))].join(", ");
  return `### ${labels || "FinTwit"} research candidate\n\n- Post: ${post.url}\n- Author: @${post.authorHandle}\n- Date: ${post.createdAt || "unknown"}\n- Search: ${labels || "unknown"}\n- Text: ${post.text.replace(/\s+/g, " ").trim()}\n- Assessment:\n`;
}

async function setStatus(post, status) {
  await setResearchPostStatus(post.id, status);
  post.status = status;
  render();
}

function renderCard(post) {
  const { score, reasons, gateReasons, passesGate } = scorePost(post);
  const labels = [...new Set((post.researchMatches || []).map((m) => m.label))];
  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = `
    <div class="card-header">
      <img class="avatar" src="${escapeHtml(post.authorAvatar)}" alt="">
      <div class="identity">
        <div class="name">${escapeHtml(post.authorName)}</div>
        <div class="handle">@${escapeHtml(post.authorHandle)}</div>
      </div>
      <a class="date" href="${escapeHtml(post.url)}" target="_blank" rel="noopener">${
        post.createdAt ? new Date(post.createdAt).toLocaleDateString() : ""
      }</a>
    </div>
    <div class="badges">
      <span class="badge quality">Quality ${score}</span>
      ${labels.map((label) => `<span class="badge">${escapeHtml(label)}</span>`).join("")}
      ${!passesGate ? '<span class="badge gated">low signal</span>' : ""}
      ${post.status !== "new" ? `<span class="badge ${post.status}">${post.status === "dismissed" ? "done" : post.status}</span>` : ""}
    </div>
    <div class="quality-reasons">${escapeHtml(reasons.join(" · ") || "limited quality signals")}</div>
    ${gateReasons.length ? `<div class="gate-reasons">Filtered: ${escapeHtml(gateReasons.join(" · "))}</div>` : ""}
    <div class="post-text">${escapeHtml(post.text)}</div>
    ${renderMedia(post)}
    <div class="stats">♥ ${post.likeCount || 0} · ↺ ${post.retweetCount || 0} · ↩ ${post.replyCount || 0}</div>
    <div class="card-actions">
      <a href="${escapeHtml(post.url)}" target="_blank" rel="noopener">View on X</a>
      <button class="keep-btn">Keep</button>
      <button class="done-btn">Done</button>
      <button class="secondary review-btn">Review again</button>
      <button class="secondary copy-btn">Copy research note</button>
      <span class="copy-feedback"></span>
    </div>`;

  const keepBtn = card.querySelector(".keep-btn");
  const doneBtn = card.querySelector(".done-btn");
  const reviewBtn = card.querySelector(".review-btn");
  keepBtn.hidden = post.status === "kept";
  doneBtn.hidden = post.status === "done" || post.status === "dismissed";
  reviewBtn.hidden = post.status === "new";
  keepBtn.addEventListener("click", () => setStatus(post, "kept"));
  doneBtn.addEventListener("click", () => setStatus(post, "done"));
  reviewBtn.addEventListener("click", () => setStatus(post, "new"));
  card.querySelector(".copy-btn").addEventListener("click", async () => {
    await navigator.clipboard.writeText(researchMarkdown(post));
    const feedback = card.querySelector(".copy-feedback");
    feedback.textContent = "Copied";
    setTimeout(() => (feedback.textContent = ""), 1500);
  });
  return card;
}

function populateLabelFilter() {
  const previous = els.labelFilter.value;
  const labels = [...new Set(posts.flatMap((p) => (p.researchMatches || []).map((m) => m.label)))].sort();
  els.labelFilter.innerHTML = '<option value="">All searches</option>' +
    labels.map((label) => `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`).join("");
  if (labels.includes(previous)) els.labelFilter.value = previous;
}

function render() {
  const view = els.statusFilter.value;
  const label = els.labelFilter.value;
  const query = els.feedSearch.value.trim().toLowerCase();
  let visible = posts.filter((post) => {
    const assessment = scorePost(post);
    const done = post.status === "done" || post.status === "dismissed";
    if (view === "review" && (post.status !== "new" || !assessment.passesGate)) return false;
    if (view === "kept" && post.status !== "kept") return false;
    if (view === "done" && !done) return false;
    if (view === "low_signal" && (post.status !== "new" || assessment.passesGate)) return false;
    if (label && !(post.researchMatches || []).some((match) => match.label === label)) return false;
    if (query) {
      const haystack = `${post.text} ${post.authorHandle} ${post.authorName}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  if (els.sortBy.value === "quality") {
    visible.sort((a, b) => scorePost(b).score - scorePost(a).score);
  } else if (els.sortBy.value === "engagement") {
    visible.sort((a, b) => totalEngagement(b) - totalEngagement(a));
  } else {
    visible.sort((a, b) => (b.discoveredAt || "").localeCompare(a.discoveredAt || ""));
  }

  els.feedCount.textContent = `${visible.length} / ${posts.length} posts`;
  els.feed.innerHTML = "";
  if (!visible.length) {
    els.feed.innerHTML = '<div class="empty">No posts in this view. Run a scan or change the filters.</div>';
    return;
  }
  for (const post of visible) els.feed.appendChild(renderCard(post));
}

async function loadPosts() {
  const [researchPosts, bookmarks] = await Promise.all([getAllResearchPosts(), getAllBookmarks()]);
  posts = researchPosts;
  savedAuthorCounts = new Map();
  for (const bookmark of bookmarks) {
    const handle = (bookmark.authorHandle || "").toLowerCase();
    if (handle) savedAuthorCounts.set(handle, (savedAuthorCounts.get(handle) || 0) + 1);
  }
  populateLabelFilter();
  render();
}

function showScanState(state) {
  const publicState = state?.public || state || { status: "idle", completed: 0, total: 0, newPosts: 0 };
  const running = publicState.status === "running";
  els.scanBtn.disabled = running;
  els.stopBtn.disabled = !running;
  if (running) {
    els.scanStatus.textContent = `Scanning ${publicState.completed + 1}/${publicState.total}: ${
      publicState.currentLabel || "starting"
    } · ${publicState.newPosts || 0} new`;
  } else if (publicState.status === "complete") {
    els.scanStatus.textContent = `Complete · ${publicState.newPosts || 0} new posts`;
  } else if (publicState.status === "stopped") {
    els.scanStatus.textContent = `Stopped after ${publicState.completed || 0}/${publicState.total || 0}`;
  } else if (publicState.status === "error") {
    els.scanStatus.textContent = `Scan failed: ${publicState.error || "unknown error"}`;
  } else {
    els.scanStatus.textContent = "Not scanning";
  }
}

let watchlistSaveTimer;
els.watchlist.addEventListener("input", () => {
  clearTimeout(watchlistSaveTimer);
  els.watchlistStatus.textContent = "Saving…";
  watchlistSaveTimer = setTimeout(async () => {
    await chrome.storage.local.set({ [WATCHLIST_KEY]: els.watchlist.value });
    const { jobs, errors } = parseWatchlist(els.watchlist.value);
    els.watchlistStatus.textContent = errors.length
      ? `${jobs.length} searches · fix ${errors.join(", ")}`
      : `${jobs.length} searches · saved locally`;
  }, 350);
});

els.scanBtn.addEventListener("click", async () => {
  const { jobs, errors } = parseWatchlist(els.watchlist.value);
  if (errors.length) {
    alert(`Fix malformed watchlist ${errors.join(", ")}. Expected: Label | query`);
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: "START_RESEARCH_SCAN", jobs });
  if (!response?.ok) {
    alert(`Could not start scan: ${response?.error || "unknown error"}`);
    return;
  }
  showScanState(response.state);
});

els.stopBtn.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "STOP_RESEARCH_SCAN" });
  if (response?.ok) showScanState(response.state);
});

for (const el of [els.feedSearch, els.statusFilter, els.labelFilter, els.sortBy]) {
  el.addEventListener(el === els.feedSearch ? "input" : "change", render);
}

els.qualityThreshold.addEventListener("change", async () => {
  const value = Math.max(0, Math.min(100, Number(els.qualityThreshold.value) || 0));
  els.qualityThreshold.value = String(value);
  await chrome.storage.local.set({ [QUALITY_THRESHOLD_KEY]: value });
  render();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "RESEARCH_SCAN_PROGRESS") return;
  showScanState(msg.state);
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(loadPosts, 250);
});

async function init() {
  const stored = await chrome.storage.local.get([WATCHLIST_KEY, QUALITY_THRESHOLD_KEY]);
  const priorWatchlist = stored[WATCHLIST_KEY] || DEFAULT_WATCHLIST;
  els.watchlist.value = migrateWatchlist(priorWatchlist);
  if (els.watchlist.value !== stored[WATCHLIST_KEY]) {
    await chrome.storage.local.set({ [WATCHLIST_KEY]: els.watchlist.value });
  }
  els.qualityThreshold.value = String(stored[QUALITY_THRESHOLD_KEY] ?? 30);
  const { jobs, errors } = parseWatchlist(els.watchlist.value);
  els.watchlistStatus.textContent = errors.length
    ? `${jobs.length} searches · fix ${errors.join(", ")}`
    : `${jobs.length} searches · saved locally`;
  const scan = await chrome.runtime.sendMessage({ type: "GET_RESEARCH_SCAN_STATUS" });
  if (scan?.ok) showScanState(scan.state);
  await loadPosts();
}

init();
