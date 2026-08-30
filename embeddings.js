import { pipeline, env } from "./vendor/transformers/transformers.min.js";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

// Vendored WASM runtime lives alongside the vendored JS — MV3 forbids
// fetching executable code from a remote CDN, so this must stay local.
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/transformers/");
env.allowLocalModels = false; // model *weights* (data, not code) fetch from HF's CDN
env.useBrowserCache = true; // ...and are cached after the first download

let extractorPromise = null;
function getExtractor(onProgress) {
  extractorPromise ??= pipeline("feature-extraction", MODEL_ID, {
    dtype: "q8",
    progress_callback: onProgress,
  });
  return extractorPromise;
}

export async function embedText(text, onProgress) {
  const extractor = await getExtractor(onProgress);
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Float32Array.from(output.data);
}

// normalize:true means every vector is already unit-length, so a plain dot
// product is equivalent to cosine similarity.
export function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function topRelated(target, all, k = 5, minScore = 0.5) {
  return all
    .filter((r) => r.id !== target.id && r.embedding)
    .map((r) => ({ record: r, score: cosineSimilarity(target.embedding, r.embedding) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// Mirrors content.js's toggleAutoScroll shape: progress callback + cancel
// flag. Filtering on !r.embedding each call means stopping and restarting
// just resumes where it left off — no separate cursor state needed.
export async function embedAllMissing(records, { onModelProgress, onItemProgress, isCancelled, persist }) {
  const todo = records.filter((r) => !r.embedding);
  for (let i = 0; i < todo.length; i++) {
    if (isCancelled()) break;
    const rec = todo[i];
    rec.embedding = await embedText(rec.text || "", i === 0 ? onModelProgress : undefined);
    rec.embeddingModel = MODEL_ID;
    await persist(rec.id, rec.embedding, MODEL_ID);
    onItemProgress(i + 1, todo.length);
  }
}
