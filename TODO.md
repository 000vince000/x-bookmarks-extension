# TODO

- Precompute own-tweet embeddings outside the browser (e.g. a batch import
  file) so desktop doesn't have to run "Compute own-tweet embeddings"
  itself. Blocked: this dev container's network policy denies
  huggingface.co, so the Xenova/all-MiniLM-L6-v2 model can't be downloaded
  here to precompute. Needs an environment with HF access, or vendoring
  the model weights like vendor/transformers/ already vendors the runtime.
