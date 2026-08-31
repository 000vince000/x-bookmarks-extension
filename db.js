export const DB_NAME = "x-bookmarks";
export const DB_VERSION = 2;
export const STORE = "bookmarks";
export const STORE_OWN_TWEETS = "ownTweets";

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
          // Only carry the embedding forward if the text it was computed
          // from hasn't changed (e.g. a parser fix now captures quoted-tweet
          // text) — otherwise it'd silently go stale against the new text.
          if (existing.text === rec.text) {
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
