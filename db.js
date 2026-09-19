export const DB_NAME = "x-bookmarks";
export const DB_VERSION = 3;
export const STORE = "bookmarks";
export const STORE_OWN_TWEETS = "ownTweets";
export const STORE_RESEARCH_POSTS = "researchPosts";

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("authorHandle", "authorHandle", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
        store.createIndex("capturedAt", "capturedAt", { unique: false });
      }
      // A reference corpus of the account owner's own tweets — used to
      // score bookmarks by similarity to what this person has personally
      // written, not by in-cluster centrality (see clusters.js).
      if (!db.objectStoreNames.contains(STORE_OWN_TWEETS)) {
        db.createObjectStore(STORE_OWN_TWEETS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_RESEARCH_POSTS)) {
        const store = db.createObjectStore(STORE_RESEARCH_POSTS, { keyPath: "id" });
        store.createIndex("discoveredAt", "discoveredAt", { unique: false });
        store.createIndex("status", "status", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Search discoveries live separately from bookmarks. Repeated scans refresh
// the public post fields and accumulate the watchlist queries that found the
// post, while preserving the owner's keep/dismiss decision.
export async function upsertResearchPosts(records, match) {
  if (!records.length) return { inserted: 0, updated: 0 };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RESEARCH_POSTS, "readwrite");
    const store = tx.objectStore(STORE_RESEARCH_POSTS);
    let inserted = 0;
    let updated = 0;
    for (const rec of records) {
      const getReq = store.get(rec.id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        const priorMatches = existing?.researchMatches || [];
        const researchMatches = match
          ? [
              ...priorMatches.filter((m) => m.label !== match.label || m.query !== match.query),
              { ...match, matchedAt: new Date().toISOString() },
            ]
          : priorMatches;
        if (existing) {
          store.put({
            ...existing,
            ...rec,
            researchMatches,
            status: existing.status || "new",
            discoveredAt: existing.discoveredAt || rec.capturedAt || new Date().toISOString(),
          });
          updated++;
        } else {
          store.put({
            ...rec,
            researchMatches,
            status: "new",
            discoveredAt: rec.capturedAt || new Date().toISOString(),
          });
          inserted++;
        }
      };
    }
    tx.oncomplete = () => resolve({ inserted, updated });
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllResearchPosts() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RESEARCH_POSTS, "readonly");
    const req = tx.objectStore(STORE_RESEARCH_POSTS).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function setResearchPostStatus(id, status) {
  // "dismissed" is retained for records created by the first research-feed
  // iteration; the UI now calls this terminal reviewed state "done".
  const allowed = new Set(["new", "kept", "done", "dismissed"]);
  if (!allowed.has(status)) throw new Error(`invalid research status: ${status}`);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RESEARCH_POSTS, "readwrite");
    const store = tx.objectStore(STORE_RESEARCH_POSTS);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) {
        reject(new Error(`research post ${id} not found`));
        return;
      }
      rec.status = status;
      rec.statusChangedAt = new Date().toISOString();
      store.put(rec);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Inserts new records, or refreshes fields on existing ones while
// preserving user-added tags/notes (capture data should never clobber those).
export async function upsertBookmarks(records) {
  if (!records.length) return { inserted: 0, updated: 0 };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    let inserted = 0;
    let updated = 0;
    for (const rec of records) {
      const getReq = store.get(rec.id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (existing) {
          const preserved = { tags: existing.tags || [], note: existing.note || "" };
          // Local-only state set from the library — a re-capture must not
          // wipe it. (archivedFromX is deliberately not carried: an archived
          // bookmark only gets re-captured if it was bookmarked again on X.)
          for (const key of ["likedOnX", "likedAt", "thread", "threadCheckedAt"]) {
            if (existing[key] !== undefined) preserved[key] = existing[key];
          }
          // An expanded thread's flattened text stands in for the tweet's
          // own (see applyThread) — keep it, refreshing just the bookmarked
          // tweet's own text alongside.
          if (existing.thread?.length > 1) {
            preserved.tweetText = rec.text;
            preserved.text = existing.text;
          }
          const nextText = preserved.text ?? rec.text;
          // Only carry the embedding forward if the text it was computed
          // from hasn't changed (e.g. a parser fix now captures quoted-tweet
          // text) — otherwise it'd silently go stale against the new text.
          if (existing.text === nextText) {
            if (existing.embedding !== undefined) preserved.embedding = existing.embedding;
            if (existing.embeddingModel !== undefined) preserved.embeddingModel = existing.embeddingModel;
            if (existing.embeddedAt !== undefined) preserved.embeddedAt = existing.embeddedAt;
          }
          store.put({ ...rec, ...preserved });
          updated++;
        } else {
          store.put({ ...rec, tags: [], note: "" });
          inserted++;
        }
      };
    }
    tx.oncomplete = () => resolve({ inserted, updated });
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllBookmarks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function updateBookmarkMeta(id, { tags, note } = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) {
        reject(new Error(`bookmark ${id} not found`));
        return;
      }
      if (tags !== undefined) rec.tags = tags;
      if (note !== undefined) rec.note = note;
      store.put(rec);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function setEmbedding(id, embedding, model) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) {
        reject(new Error(`bookmark ${id} not found`));
        return;
      }
      rec.embedding = embedding;
      rec.embeddingModel = model;
      rec.embeddedAt = new Date().toISOString();
      store.put(rec);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Records a thread check's result on a bookmark (mutating it in place, so
// library.js can apply the same change to its in-memory copy). `thread` is
// the author's full self-reply chain from its first tweet, or [] when the
// bookmark isn't part of one. For a real thread the flattened text
// replaces `text` — so search, embeddings and topic grouping all see the
// whole thread — with the bookmarked tweet's own text kept in `tweetText`.
// A text change drops the now-stale embedding, same rule as
// upsertBookmarks. Returns whether the text changed.
export function applyThread(rec, thread) {
  rec.thread = thread;
  rec.threadCheckedAt = new Date().toISOString();
  if (thread.length < 2) return false;
  rec.tweetText ??= rec.text;
  const text = thread.map((t) => t.text).filter(Boolean).join("\n\n");
  if (text === rec.text) return false;
  rec.text = text;
  delete rec.embedding;
  delete rec.embeddingModel;
  delete rec.embeddedAt;
  return true;
}

export async function setThread(id, thread) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) {
        reject(new Error(`bookmark ${id} not found`));
        return;
      }
      applyThread(rec, thread);
      store.put(rec);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteBookmark(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Unlike deleteBookmark, keeps the local record — just flags it as no
// longer live on X, so X's bookmark list can be pruned over time without
// losing anything from the library.
export async function archiveBookmark(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) {
        reject(new Error(`bookmark ${id} not found`));
        return;
      }
      rec.archivedFromX = true;
      rec.archivedAt = new Date().toISOString();
      store.put(rec);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Flags a bookmark as liked on X — mirrors archiveBookmark's shape/pattern.
export async function likeBookmark(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) {
        reject(new Error(`bookmark ${id} not found`));
        return;
      }
      rec.likedOnX = true;
      rec.likedAt = new Date().toISOString();
      store.put(rec);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Own-tweets corpus — mirrors upsertBookmarks/setEmbedding's shape, minus
// tags/notes (meaningless here) but keeping the same text-change-invalidates
// embedding safeguard.
export async function upsertOwnTweets(records) {
  if (!records.length) return { inserted: 0, updated: 0 };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_OWN_TWEETS, "readwrite");
    const store = tx.objectStore(STORE_OWN_TWEETS);
    let inserted = 0;
    let updated = 0;
    for (const rec of records) {
      const getReq = store.get(rec.id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (existing) {
          const preserved = {};
          if (existing.text === rec.text) {
            if (existing.embedding !== undefined) preserved.embedding = existing.embedding;
            if (existing.embeddingModel !== undefined) preserved.embeddingModel = existing.embeddingModel;
            if (existing.embeddedAt !== undefined) preserved.embeddedAt = existing.embeddedAt;
          }
          store.put({ ...rec, ...preserved });
          updated++;
        } else {
          store.put(rec);
          inserted++;
        }
      };
    }
    tx.oncomplete = () => resolve({ inserted, updated });
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllOwnTweets() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_OWN_TWEETS, "readonly");
    const req = tx.objectStore(STORE_OWN_TWEETS).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function setOwnTweetEmbedding(id, embedding, model) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_OWN_TWEETS, "readwrite");
    const store = tx.objectStore(STORE_OWN_TWEETS);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) {
        reject(new Error(`own tweet ${id} not found`));
        return;
      }
      rec.embedding = embedding;
      rec.embeddingModel = model;
      rec.embeddedAt = new Date().toISOString();
      store.put(rec);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getCount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
