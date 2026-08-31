// Unsupervised topic grouping over already-computed embeddings — no LLM calls.
// Vectors are unit-normalized (embeddings.js uses normalize:true), so plain
// Euclidean k-means is equivalent to clustering by cosine similarity:
// ||a-b||^2 = 2 - 2*cos(a,b).

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "for", "is", "are", "was",
  "were", "be", "been", "being", "this", "that", "these", "those", "it", "its", "as", "at", "by",
  "with", "from", "about", "into", "over", "after", "before", "i", "you", "he", "she", "we", "they",
  "them", "his", "her", "their", "our", "your", "my", "me", "us", "him", "not", "no", "yes", "do",
  "does", "did", "have", "has", "had", "will", "would", "can", "could", "should", "may", "might",
  "just", "so", "than", "then", "there", "here", "what", "which", "who", "whom", "when", "where",
  "why", "how", "all", "any", "some", "more", "most", "other", "such", "only", "own", "same", "too",
  "very", "don", "now", "amp", "rt", "via", "new", "one", "get", "like", "also", "really", "much",
  "many", "first", "two",
]);

// Chinese (and CJK generally) has no spaces between words, so the Latin
// whitespace-split approach below produces nothing useful for it — the old
// version's [^a-z\s] strip silently deleted Chinese characters entirely,
// leaving CJK-heavy clusters unlabeled ("misc"). Real word segmentation is
// a much harder problem; character bigrams over CJK runs are a common,
// dependency-free approximation — most Chinese words are 1-3 characters,
// so overlapping bigrams capture a lot of real word-level signal. Generic
// filler bigrams still get down-weighted by the existing corpus-wide IDF,
// the same mechanism that already suppresses English stopword-ish terms.
const CJK_RANGE = /[一-鿿]+/g;

function cjkBigrams(text) {
  const tokens = [];
  for (const run of text.match(CJK_RANGE) || []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

function tokenize(text) {
  const cleaned = (text || "").replace(/https?:\/\/\S+/g, " ").replace(/[@#]\w+/g, " ");
  const latin = cleaned
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...latin, ...cjkBigrams(cleaned)];
}

// Document frequency (in how many tweets, corpus-wide, each word appears
// at least once) — the basis for down-weighting words that are common
// everywhere (e.g. "people", "using", "best") so they can't win a label
// just by being generic-frequent.
function buildCorpusDocFreq(records) {
  const df = new Map();
  for (const r of records) {
    for (const w of new Set(tokenize(r.text))) {
      df.set(w, (df.get(w) || 0) + 1);
    }
  }
  return df;
}

function labelCluster(records, corpusDocFreq, corpusSize, topN = 3) {
  const clusterFreq = new Map();
  for (const r of records) {
    for (const w of new Set(tokenize(r.text))) {
      clusterFreq.set(w, (clusterFreq.get(w) || 0) + 1);
    }
  }
  const scored = [...clusterFreq.entries()].map(([w, tf]) => {
    const df = corpusDocFreq.get(w) || 1;
    const idf = Math.log((corpusSize + 1) / (df + 1)) + 1; // smoothed, always > 0
    return [w, tf * idf];
  });
  scored.sort((a, b) => b[1] - a[1]);
  const top = scored.slice(0, topN);
  return top.length ? top.map(([w]) => w).join(" · ") : "misc";
}

// Deterministic PRNG (mulberry32) so k-means++ initialization — and
// therefore the final clustering — is reproducible for the same input
// instead of reshuffling on every page load. Math.random() has no seed
// hook, so it can't be made stable without swapping it out entirely.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CLUSTER_SEED = 42;

function distanceSquared(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

function kmeansPlusPlusInit(vectors, k, rng) {
  const centroids = [vectors[Math.floor(rng() * vectors.length)]];
  while (centroids.length < k) {
    const distances = vectors.map((v) => Math.min(...centroids.map((c) => distanceSquared(v, c))));
    const sum = distances.reduce((a, b) => a + b, 0);
    let r = rng() * sum;
    let idx = 0;
    for (; idx < distances.length - 1; idx++) {
      r -= distances[idx];
      if (r <= 0) break;
    }
    centroids.push(vectors[idx]);
  }
  return centroids;
}

function kmeans(vectors, k, iterations = 25) {
  const rng = mulberry32(CLUSTER_SEED);
  let centroids = kmeansPlusPlusInit(vectors, k, rng);
  const assignments = new Array(vectors.length).fill(0);

  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    for (let i = 0; i < vectors.length; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = distanceSquared(vectors[i], centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (assignments[i] !== best) changed = true;
      assignments[i] = best;
    }

    const dim = vectors[0].length;
    const sums = Array.from({ length: k }, () => new Float32Array(dim));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      const c = assignments[i];
      counts[c]++;
      const v = vectors[i];
      for (let d = 0; d < dim; d++) sums[c][d] += v[d];
    }
    centroids = sums.map((sum, c) => (counts[c] > 0 ? sum.map((x) => x / counts[c]) : centroids[c]));

    if (!changed) break;
  }
  return assignments;
}

export function computeClusters(records, k, ownTweetEmbeddings = []) {
  const vectors = records.map((r) => r.embedding);
  const assignments = kmeans(vectors, Math.min(k, records.length));
  const groups = new Map();
  records.forEach((r, i) => {
    const c = assignments[i];
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(r);
  });
  const corpusDocFreq = buildCorpusDocFreq(records);
  return [...groups.values()]
    .map((members) => {
      const { centralId, scores } = mostRepresentativeId(
        members,
        ownTweetEmbeddings,
        corpusDocFreq,
        records.length
      );
      return {
        label: labelCluster(members, corpusDocFreq, records.length),
        members,
        centralId,
        scores, // Map<tweetId, personalRelevance> — every member, not just the winner
      };
    })
    .sort((a, b) => b.members.length - a.members.length);
}

function idf(word, corpusDocFreq, corpusSize) {
  const df = corpusDocFreq.get(word) || 1;
  return Math.log((corpusSize + 1) / (df + 1)) + 1;
}

// A tweet needs at least this many tokens before any text-derived score is
// trusted at full strength — below this, near-empty text (a bare mention +
// link, nothing else) isn't semantically trustworthy either way: not for
// informativeness (no words to judge rarity from) and not for embedding
// similarity (MiniLM's embedding for near-empty text is non-distinctive,
// so it can look deceptively "similar" to other equally-thin text without
// either one actually saying anything). Ramped, not a hard cutoff.
const MIN_SUBSTANTIVE_TOKENS = 8;

function lengthConfidence(tokenCount) {
  return Math.min(1, tokenCount / MIN_SUBSTANTIVE_TOKENS);
}

// Same bar, applied on the *reference* side: a thin/no-context tweet of
// yours shouldn't be eligible as a personalRelevance anchor at all —
// otherwise it can inflate some unrelated bookmark's score just by both
// being equally content-free (see personalRelevance's discount for the
// candidate side of this same problem).
export function isSubstantive(text) {
  return tokenize(text).length >= MIN_SUBSTANTIVE_TOKENS;
}

// Average corpus-wide term rarity across a tweet's own tokens — a real
// information-theoretic proxy for how much this specific wording actually
// says, not just a length or engagement heuristic. Generic boilerplate
// ("Today, X is widely recognized as...") is built almost entirely from
// corpus-common words and scores low; text using more distinctive terms
// scores higher. Averaged (not summed) so longer text doesn't win purely
// by having more tokens, then discounted for tweets too short to trust
// that average (see MIN_SUBSTANTIVE_TOKENS).
function informativeness(text, corpusDocFreq, corpusSize) {
  const tokens = tokenize(text);
  if (!tokens.length) return 0;
  const total = tokens.reduce((sum, w) => sum + idf(w, corpusDocFreq, corpusSize), 0);
  return (total / tokens.length) * lengthConfidence(tokens.length);
}

// How closely a tweet resembles anything this account owner has personally
// written — the max, not the average, over their own-tweets corpus. Max
// (nearest-neighbor) rather than similarity-to-the-corpus-average, for the
// same reason average-based cluster centrality got dropped: averaging
// across thousands of your own tweets would wash out into a single bland
// "voice centroid" that rewards generic content again. A max-similarity
// match means "this specifically resembles something I personally cared
// enough about to write," regardless of how that fits your overall average.
function personalRelevance(text, embedding, ownTweetEmbeddings) {
  if (!ownTweetEmbeddings.length) return 0;
  let best = -Infinity;
  for (const ownVec of ownTweetEmbeddings) {
    let score = 0;
    for (let d = 0; d < embedding.length; d++) score += embedding[d] * ownVec[d];
    if (score > best) best = score;
  }
  // A near-empty tweet (bare mention + link, nothing else) can embed as
  // deceptively "similar" to other equally-thin text without either one
  // actually saying anything — discount the same way informativeness does.
  return best * lengthConfidence(tokenize(text).length);
}

// The representative "start here" tweet for a topic: first narrow to the
// candidates most similar to something the account owner has personally
// tweeted (an external, stable reference — unlike in-cluster centrality,
// it doesn't shift just because the cluster's membership changes as
// bookmarks get deleted), then pick the most informative one among them,
// so a merely-generic post can't win just for resembling your own voice
// in a shallow way.
function mostRepresentativeId(members, ownTweetEmbeddings, corpusDocFreq, corpusSize) {
  const scores = new Map(members.map((r) => [r.id, personalRelevance(r.text, r.embedding, ownTweetEmbeddings)]));
  if (members.length === 1) return { centralId: members[0].id, scores };

  const ranked = [...members].sort((a, b) => scores.get(b.id) - scores.get(a.id));
  const shortlist = ranked.slice(0, Math.max(3, Math.ceil(members.length * 0.2)));
  let best = shortlist[0];
  let bestScore = -Infinity;
  for (const r of shortlist) {
    const score = informativeness(r.text, corpusDocFreq, corpusSize);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return { centralId: best.id, scores };
}
