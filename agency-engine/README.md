# Black Ops Marketing engine

Standalone async Python engine — not part of the Vercel app (excluded in `.vercelignore`).

brief → hook memory (FAISS or Pinecone) → strategist → editor gate (≥ 8/10, sent back with fixes) → every platform written concurrently

## Run

```
pip install -r requirements.txt
export LLM_API_KEY=... LLM_MODEL=...        # LLM_BASE_URL for OpenRouter etc.
python black_ops_engine.py seed hooks.json
python black_ops_engine.py run brief.json --platforms x linkedin email
pytest -q test_black_ops_engine.py         # no network or keys needed
```

`hooks.json`: `[{"id": "h1", "text": "...", "platform": "any", "performance": 0.09}]`
`brief.json`: `{"product": "...", "audience": "...", "offer": "...", "facts": ["..."], "platforms": ["x", "email"]}`

`facts` are the only claims copy may make. Any figure not in `facts` or a retrieved hook is rejected as a hallucination.

Exit codes: 0 ok · 1 config/API error · 2 no draft passed the editor (best draft on stderr) · 3 some platforms failed.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `LLM_API_KEY`, `LLM_MODEL` | required | Chat provider key and model for every role |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `STRATEGIST_MODEL` / `EDITOR_MODEL` / `ADAPTER_MODEL` | `LLM_MODEL` | Per-role models; a different editor model is recommended |
| `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` | LLM values | Set when your chat provider doesn't serve embeddings |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Changing it later means rebuilding the index |
| `VECTOR_BACKEND` | `faiss` | `faiss` or `pinecone` |
| `FAISS_INDEX_DIR` | `./hook_index` | |
| `PINECONE_API_KEY`, `PINECONE_INDEX` | required for pinecone | Index metric `cosine`, dimension = embedding size |
| `PINECONE_NAMESPACE` | `hooks` | |
| `HOOK_TOP_K` / `HOOK_MIN_SIMILARITY` | `5` / `0.25` | Cutoff is model-dependent; tune on your own hooks |
| `RUTHLESSNESS_THRESHOLD` / `MAX_REVISIONS` | `8` / `3` | Pass mark and rewrites before giving up |
| `MAX_CONCURRENCY` | `5` | Platforms written at once |
| `LLM_TIMEOUT_S` / `LLM_MAX_RETRIES` | `60` / `5` | |
| `LLM_JSON_MODE` | `true` | `false` for models that reject JSON mode |
| `LOG_LEVEL` | `INFO` | |
