"""
Black Ops Marketing engine: async strategy generation with a ruthless editor
gate, hook memory, and concurrent multi-platform adaptation.

    brief ─► HookMemory.top_hooks()            FAISS (local) or Pinecone
          ─► Strategist ─► Editor ─► score ≥ threshold? ── yes ─► StrategyResult
                 ▲                              │ no
                 └──── editor's fixes ◄─────────┘   (max_revisions, then QualityGateFailed)
          ─► scale_content(): one Adapter call per platform, concurrent, bounded

Any OpenAI-compatible endpoint works (OpenAI, OpenRouter, Groq, Cerebras,
NVIDIA NIM, ...): set LLM_BASE_URL. Embeddings have their own endpoint
settings because not every chat provider serves them.

CLI:
    python black_ops_engine.py seed hooks.json
    python black_ops_engine.py run brief.json [--platforms x linkedin email]
"""

from __future__ import annotations

import argparse
import asyncio
import email.utils
import json
import logging
import os
import random
import re
import sys
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, TypeVar

import numpy as np
import openai
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

log = logging.getLogger("black_ops")

T = TypeVar("T", bound=BaseModel)

# Automation action types
ACTION_TYPES = ["CLICK", "TYPE", "NAVIGATE", "SCRAPE", "WAIT"]

# Automation action types
ACTION_TYPES = ["CLICK", "TYPE", "NAVIGATE", "SCRAPE", "WAIT"]


# ── errors ──────────────────────────────────────────────────────────────────

class EngineError(Exception):
    """Base for every failure the engine reports on purpose."""


class ConfigError(EngineError):
    pass


class LLMUnavailable(EngineError):
    """Retries exhausted, or a non-retryable API error (auth, bad request)."""


class HallucinationError(EngineError):
    """The model never produced output that parsed and passed grounding checks."""


class QualityGateFailed(EngineError):
    """No draft reached the ruthlessness threshold. `best` holds the top attempt."""

    def __init__(self, best: "StrategyResult", threshold: int):
        self.best = best
        super().__init__(
            f"best draft scored {best.final_score}/10 after {best.attempts} attempts "
            f"(needs {threshold})"
        )


# ── settings ────────────────────────────────────────────────────────────────

def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as e:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from e


def _float_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError as e:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from e


@dataclass(frozen=True)
class Settings:
    llm_api_key: str
    llm_base_url: str
    strategist_model: str
    editor_model: str
    adapter_model: str
    embedding_api_key: str
    embedding_base_url: str
    embedding_model: str
    vector_backend: str = "faiss"
    faiss_index_dir: Path = Path("./hook_index")
    pinecone_api_key: str | None = None
    pinecone_index: str | None = None
    pinecone_namespace: str = "hooks"
    hook_top_k: int = 5
    # Cosine floor for "relevant". Model-dependent: tune it on your own hooks.
    hook_min_similarity: float = 0.25
    ruthlessness_threshold: int = 8
    max_revisions: int = 3
    max_concurrency: int = 5
    llm_timeout_s: float = 60.0
    llm_max_retries: int = 5
    json_mode: bool = True

    @classmethod
    def from_env(cls) -> "Settings":
        def need(name: str) -> str:
            v = os.getenv(name, "").strip()
            if not v:
                raise ConfigError(f"{name} is required")
            return v

        llm_key = need("LLM_API_KEY")
        model = need("LLM_MODEL")
        backend = os.getenv("VECTOR_BACKEND", "faiss").strip().lower()
        if backend not in ("faiss", "pinecone"):
            raise ConfigError(f"VECTOR_BACKEND must be faiss or pinecone, got {backend!r}")
        s = cls(
            llm_api_key=llm_key,
            llm_base_url=os.getenv("LLM_BASE_URL", "https://api.openai.com/v1"),
            strategist_model=os.getenv("STRATEGIST_MODEL") or model,
            editor_model=os.getenv("EDITOR_MODEL") or model,
            adapter_model=os.getenv("ADAPTER_MODEL") or model,
            embedding_api_key=os.getenv("EMBEDDING_API_KEY") or llm_key,
            embedding_base_url=(
                os.getenv("EMBEDDING_BASE_URL")
                or os.getenv("LLM_BASE_URL", "https://api.openai.com/v1")
            ),
            embedding_model=os.getenv("EMBEDDING_MODEL", "text-embedding-3-small"),
            vector_backend=backend,
            faiss_index_dir=Path(os.getenv("FAISS_INDEX_DIR", "./hook_index")),
            pinecone_api_key=os.getenv("PINECONE_API_KEY"),
            pinecone_index=os.getenv("PINECONE_INDEX"),
            pinecone_namespace=os.getenv("PINECONE_NAMESPACE", "hooks"),
            hook_top_k=_int_env("HOOK_TOP_K", 5),
            hook_min_similarity=_float_env("HOOK_MIN_SIMILARITY", 0.25),
            ruthlessness_threshold=_int_env("RUTHLESSNESS_THRESHOLD", 8),
            max_revisions=_int_env("MAX_REVISIONS", 3),
            max_concurrency=_int_env("MAX_CONCURRENCY", 5),
            llm_timeout_s=float(_int_env("LLM_TIMEOUT_S", 60)),
            llm_max_retries=_int_env("LLM_MAX_RETRIES", 5),
            json_mode=os.getenv("LLM_JSON_MODE", "true").lower() not in ("0", "false", "no"),
        )
        if backend == "pinecone" and not (s.pinecone_api_key and s.pinecone_index):
            raise ConfigError("VECTOR_BACKEND=pinecone needs PINECONE_API_KEY and PINECONE_INDEX")
        if not 1 <= s.ruthlessness_threshold <= 10:
            raise ConfigError("RUTHLESSNESS_THRESHOLD must be 1-10")
        return s


# ── data models ─────────────────────────────────────────────────────────────

class Brief(BaseModel):
    product: str
    audience: str
    offer: str
    # The ONLY claims copy may make. Any figure not in here (or in a retrieved
    # hook) is treated as a hallucination and rejected.
    facts: list[str] = Field(default_factory=list)
    tone: str = "direct, blunt, specific"
    platforms: list[str] = Field(default_factory=lambda: ["x", "linkedin", "email"])


class Hook(BaseModel):
    id: str
    text: str
    platform: str = "any"
    niche: str = ""
    # Higher is better: CTR, engagement rate, reply rate — one unit per index.
    performance: float = Field(ge=0)


class Strategy(BaseModel):
    positioning: str
    pain_point: str
    core_message: str
    hook_ids_used: list[str] = Field(default_factory=list)
    angles: list[str] = Field(min_length=1, max_length=5)
    master_copy: str = Field(min_length=40)
    cta: str


class EditorVerdict(BaseModel):
    ruthlessness_score: int = Field(ge=1, le=10)
    directness: int = Field(ge=1, le=10)
    fluff_free: int = Field(ge=1, le=10)
    fluff_found: list[str] = Field(default_factory=list)
    unsupported_claims: list[str] = Field(default_factory=list)
    fixes: list[str] = Field(default_factory=list)


class Adaptation(BaseModel):
    platform: str
    text: str
    hashtags: list[str] = Field(default_factory=list)


@dataclass
class StrategyResult:
    strategy: Strategy
    verdict: EditorVerdict
    final_score: int
    attempts: int
    hooks: list[Hook]
    fluff_hits: list[str] = field(default_factory=list)


@dataclass
class ScaleResult:
    adaptations: dict[str, Adaptation]
    failures: dict[str, str]


@dataclass(frozen=True)
class PlatformSpec:
    max_chars: int  # editorial limit, at or under the platform's hard limit
    rules: str


PLATFORMS: dict[str, PlatformSpec] = {
    "x": PlatformSpec(280, "One punch, one post, no thread. At most 2 hashtags."),
    "linkedin": PlatformSpec(
        1300,
        "First line must land before the 'see more' fold (under 140 chars). "
        "Short paragraphs. At most 3 hashtags at the end.",
    ),
    "instagram": PlatformSpec(
        1000, "First line stops the scroll. Caption only. Up to 5 hashtags at the end."
    ),
    "facebook": PlatformSpec(500, "Conversational, two to four short lines, no hashtags."),
    "tiktok": PlatformSpec(
        600, "A 20-30 second spoken script: hook in the first 2 seconds, then proof, then CTA."
    ),
    "email": PlatformSpec(
        1500, "First line is 'Subject: ...' (under 50 chars). Then a plain-text body. One CTA."
    ),
}


# ── grounding checks (deterministic hallucination + fluff guards) ───────────

# Figures that read as claims: percentages, multipliers, money, counts with
# k/m suffixes, and any number of 10 or more.
_FIGURE_RE = re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?[kmb]?|\d[\d,]*(?:\.\d+)?\s?(?:%|x\b|[kmb]\b|\+)?", re.I)

FLUFF_PATTERNS = [
    r"game[- ]changer", r"\bunlock", r"\belevate", r"\bseamless", r"cutting[- ]edge",
    r"\brevolutioni[sz]e", r"\bsynerg", r"\bleverage", r"in today'?s", r"fast[- ]paced",
    r"world[- ]class", r"best[- ]in[- ]class", r"next level", r"\bempower", r"\brobust",
    r"\binnovative", r"\bjourney\b", r"\bdelve", r"look no further", r"\bsupercharge",
    r"\bunleash", r"\bholistic", r"\bparadigm", r"take .{1,20} to the next",
]
_FLUFF_RE = re.compile("|".join(FLUFF_PATTERNS), re.I)


def _norm_figure(s: str) -> str:
    return re.sub(r"[\s,]", "", s).lower().rstrip(".")


def _figures(text: str) -> list[str]:
    out = []
    for m in _FIGURE_RE.finditer(text):
        tok = m.group(0).strip()
        bare = re.fullmatch(r"\d+", tok)
        # "3 steps", "5 reasons" are structure and "in 2026" is a date — not claims.
        if bare and (int(tok) < 10 or 1900 <= int(tok) <= 2100):
            continue
        out.append(tok)
    return out


def unsupported_figures(text: str, sources: list[str]) -> list[str]:
    allowed = {_norm_figure(f) for s in sources for f in _figures(s)}
    return sorted({f for f in _figures(text) if _norm_figure(f) not in allowed})


def find_fluff(text: str) -> list[str]:
    return sorted({m.group(0).lower() for m in _FLUFF_RE.finditer(text)})


# ── LLM client: retries, rate limits, structured output with repair ────────

def _retry_after_seconds(err: Exception) -> float | None:
    resp = getattr(err, "response", None)
    headers = getattr(resp, "headers", None)
    if not headers:
        return None
    raw = headers.get("retry-after-ms")
    if raw:
        try:
            return float(raw) / 1000
        except ValueError:
            pass
    raw = headers.get("retry-after")
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        try:
            when = email.utils.parsedate_to_datetime(raw)
            return max(0.0, when.timestamp() - time.time())
        except (TypeError, ValueError):
            return None


def _is_retryable(err: Exception) -> bool:
    if isinstance(err, (openai.RateLimitError, openai.APIConnectionError, openai.InternalServerError)):
        return True  # APITimeoutError subclasses APIConnectionError
    if isinstance(err, openai.APIStatusError):
        return err.status_code in (408, 409) or err.status_code >= 500
    return False


def _extract_json(raw: str) -> Any:
    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object in reply")
    return json.loads(text[start : end + 1])


def _short(err: Exception, limit: int = 600) -> str:
    s = str(err)
    return s if len(s) <= limit else s[:limit] + "…"


class LLM:
    """Thin async wrapper around one OpenAI-compatible endpoint."""

    def __init__(
        self,
        api_key: str,
        base_url: str,
        *,
        timeout: float = 60.0,
        max_retries: int = 5,
        json_mode: bool = True,
        http_client: Any = None,
        max_backoff_s: float = 30.0,
    ):
        # SDK retries off: we own retry policy so Retry-After and logging are consistent.
        self._client = AsyncOpenAI(
            api_key=api_key, base_url=base_url, timeout=timeout, max_retries=0,
            **({"http_client": http_client} if http_client is not None else {}),
        )
        self.max_retries = max_retries
        self.json_mode = json_mode
        self.max_backoff_s = max_backoff_s

    async def aclose(self) -> None:
        await self._client.close()

    async def _with_retries(self, what: str, fn: Callable[..., Any], **kwargs: Any) -> Any:
        for attempt in range(self.max_retries + 1):
            try:
                return await fn(**kwargs)
            except openai.APIError as e:
                if not _is_retryable(e):
                    status = getattr(e, "status_code", "?")
                    raise LLMUnavailable(f"{what}: HTTP {status}: {_short(e)}") from e
                if attempt == self.max_retries:
                    raise LLMUnavailable(f"{what}: gave up after {attempt + 1} tries: {_short(e)}") from e
                hinted = _retry_after_seconds(e)
                delay = hinted if hinted is not None else min(
                    self.max_backoff_s, (2 ** attempt) + random.uniform(0, 1)
                )
                delay = min(delay, self.max_backoff_s * 2)
                log.warning("%s: %s, retry %d/%d in %.1fs",
                            what, type(e).__name__, attempt + 1, self.max_retries, delay)
                await asyncio.sleep(delay)
        raise AssertionError("unreachable")

    async def complete_json(
        self,
        *,
        model: str,
        system: str,
        user: str,
        schema: type[T],
        temperature: float = 0.7,
        repair_attempts: int = 2,
        validate: Callable[[T], None] | None = None,
    ) -> T:
        """Chat completion parsed into `schema`.

        Malformed JSON, schema violations, and anything `validate` rejects are
        fed back to the model with the exact reason, up to `repair_attempts`.
        """
        schema_json = json.dumps(schema.model_json_schema(), separators=(",", ":"))
        messages: list[dict[str, str]] = [
            {"role": "system", "content": f"{system}\n\nReply with ONLY a JSON object matching this schema:\n{schema_json}"},
            {"role": "user", "content": user},
        ]
        last_err: Exception | None = None
        for attempt in range(repair_attempts + 1):
            kwargs: dict[str, Any] = {"model": model, "messages": messages, "temperature": temperature}
            if self.json_mode:
                kwargs["response_format"] = {"type": "json_object"}
            try:
                resp = await self._with_retries(model, self._client.chat.completions.create, **kwargs)
            except LLMUnavailable as e:
                # Some models reject response_format; fall back to prompt-only JSON once.
                cause = e.__cause__
                if (self.json_mode and isinstance(cause, openai.BadRequestError)
                        and "response_format" in str(cause)):
                    log.warning("%s rejects response_format; using prompt-only JSON", model)
                    self.json_mode = False
                    kwargs.pop("response_format")
                    resp = await self._with_retries(model, self._client.chat.completions.create, **kwargs)
                else:
                    raise
            raw = (resp.choices[0].message.content or "") if resp.choices else ""
            try:
                obj = schema.model_validate(_extract_json(raw))
                if validate:
                    validate(obj)
                return obj
            except ValueError as e:  # JSONDecodeError and pydantic ValidationError both subclass it
                last_err = e
                log.warning("%s output rejected (attempt %d/%d): %s",
                            model, attempt + 1, repair_attempts + 1, _short(e, 200))
                messages += [
                    {"role": "assistant", "content": raw[:6000]},
                    {"role": "user", "content": f"Rejected: {_short(e)}\nReply again with ONLY the corrected JSON."},
                ]
        raise HallucinationError(f"{model} never produced valid {schema.__name__}: {_short(last_err or Exception())}")

    async def embed(self, texts: list[str], model: str) -> np.ndarray:
        resp = await self._with_retries(f"embed:{model}", self._client.embeddings.create, model=model, input=texts)
        rows = sorted(resp.data, key=lambda d: d.index)
        vecs = np.asarray([r.embedding for r in rows], dtype="float32")
        if vecs.shape[0] != len(texts):
            raise LLMUnavailable(f"embed:{model}: asked for {len(texts)} vectors, got {vecs.shape[0]}")
        return vecs


def _normalize(v: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(v, axis=1, keepdims=True)
    return v / np.where(norms == 0, 1, norms)


# ── hook memory ─────────────────────────────────────────────────────────────

class HookMemory(ABC):
    def __init__(self, embedder: LLM, embedding_model: str):
        self._embedder = embedder
        self._embedding_model = embedding_model

    async def _embed(self, texts: list[str]) -> np.ndarray:
        return _normalize(await self._embedder.embed(texts, self._embedding_model))

    async def top_hooks(
        self, query: str, k: int = 5, platform: str | None = None, min_similarity: float = 0.25
    ) -> list[Hook]:
        """Relevant hooks first, then the best performers among them."""
        candidates = await self._search(query, k * 4, platform)
        relevant = [h for h, sim in candidates if sim >= min_similarity]
        return sorted(relevant, key=lambda h: h.performance, reverse=True)[:k]

    @abstractmethod
    async def _search(self, query: str, n: int, platform: str | None) -> list[tuple[Hook, float]]: ...

    @abstractmethod
    async def add(self, hooks: list[Hook]) -> None:
        """Insert new hooks; an existing id with the same text only updates its metadata."""


class FaissHookMemory(HookMemory):
    """Local cosine index (inner product on unit vectors), persisted to a directory."""

    def __init__(self, embedder: LLM, embedding_model: str, index_dir: Path):
        super().__init__(embedder, embedding_model)
        import faiss  # lazy: Pinecone users don't need it

        self._faiss = faiss
        self._dir = Path(index_dir)
        self._lock = asyncio.Lock()
        self._index: Any = None
        self._hooks: list[Hook] = []  # row i of the index ↔ self._hooks[i]
        idx_path, meta_path = self._dir / "index.faiss", self._dir / "hooks.json"
        if idx_path.exists() and meta_path.exists():
            self._index = faiss.read_index(str(idx_path))
            self._hooks = [Hook.model_validate(h) for h in json.loads(meta_path.read_text())]
            if self._index.ntotal != len(self._hooks):
                raise EngineError(f"{self._dir}: index has {self._index.ntotal} rows, metadata {len(self._hooks)}")

    def _persist(self) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        tmp_idx, tmp_meta = self._dir / "index.faiss.tmp", self._dir / "hooks.json.tmp"
        self._faiss.write_index(self._index, str(tmp_idx))
        tmp_meta.write_text(json.dumps([h.model_dump() for h in self._hooks]))
        os.replace(tmp_idx, self._dir / "index.faiss")
        os.replace(tmp_meta, self._dir / "hooks.json")

    async def add(self, hooks: list[Hook]) -> None:
        if not hooks:
            return
        async with self._lock:
            by_id = {h.id: i for i, h in enumerate(self._hooks)}
            fresh: list[Hook] = []
            for h in hooks:
                i = by_id.get(h.id)
                if i is None:
                    fresh.append(h)
                elif self._hooks[i].text == h.text:
                    self._hooks[i] = h
                else:
                    raise EngineError(f"hook {h.id!r} already exists with different text; use a new id")
            if fresh:
                vecs = await self._embed([h.text for h in fresh])
                if self._index is None:
                    self._index = self._faiss.IndexFlatIP(vecs.shape[1])
                elif vecs.shape[1] != self._index.d:
                    raise EngineError(f"embedding dim {vecs.shape[1]} != index dim {self._index.d}; "
                                      "changed EMBEDDING_MODEL? rebuild the index")
                self._index.add(vecs)
                self._hooks.extend(fresh)
            await asyncio.to_thread(self._persist)

    async def _search(self, query: str, n: int, platform: str | None) -> list[tuple[Hook, float]]:
        if self._index is None or self._index.ntotal == 0:
            return []
        q = await self._embed([query])
        # FAISS has no metadata filter: overfetch, then filter by platform.
        fetch = min(self._index.ntotal, n * 3 if platform else n)
        sims, rows = await asyncio.to_thread(self._index.search, q, fetch)
        out = []
        for sim, row in zip(sims[0], rows[0]):
            if row < 0:
                continue
            h = self._hooks[row]
            if platform and h.platform not in ("any", platform):
                continue
            out.append((h, float(sim)))
        return out[:n]


class PineconeHookMemory(HookMemory):
    """Managed index. Create it with metric=cosine and dimension = your embedding size."""

    def __init__(self, embedder: LLM, embedding_model: str, *, api_key: str = "",
                 index_name: str = "", namespace: str = "hooks", index: Any = None):
        super().__init__(embedder, embedding_model)
        if index is None:
            from pinecone import Pinecone  # lazy: FAISS users don't need it

            index = Pinecone(api_key=api_key).Index(index_name)
        self._index = index
        self._ns = namespace

    async def add(self, hooks: list[Hook]) -> None:
        if not hooks:
            return
        vecs = await self._embed([h.text for h in hooks])
        items = [
            {"id": h.id, "values": v.tolist(), "metadata": h.model_dump(exclude={"id"})}
            for h, v in zip(hooks, vecs)
        ]
        for i in range(0, len(items), 100):
            await asyncio.to_thread(self._index.upsert, vectors=items[i : i + 100], namespace=self._ns)

    async def _search(self, query: str, n: int, platform: str | None) -> list[tuple[Hook, float]]:
        q = await self._embed([query])
        flt = {"platform": {"$in": [platform, "any"]}} if platform else None
        res = await asyncio.to_thread(
            self._index.query, vector=q[0].tolist(), top_k=n,
            include_metadata=True, namespace=self._ns, filter=flt,
        )
        matches = getattr(res, "matches", None)
        if matches is None and isinstance(res, dict):
            matches = res.get("matches", [])
        out = []
        for m in matches or []:
            get = (lambda k, d=None: m.get(k, d)) if isinstance(m, dict) else (lambda k, d=None: getattr(m, k, d))
            meta = dict(get("metadata") or {})
            try:
                out.append((Hook(id=get("id"), **meta), float(get("score", 0.0))))
            except ValueError as e:
                log.warning("skipping malformed hook %s: %s", get("id"), _short(e, 120))
        return out


# ── prompts ─────────────────────────────────────────────────────────────────

STRATEGIST_SYSTEM = """You are the strategist at a direct-response marketing shop. Copy that sells is specific and blunt.
Rules:
- Lead with the customer's pain or desire, never with the product.
- One idea per sentence. No hedging, no throat-clearing, no buzzwords.
- Every claim — number, result, guarantee, testimonial — must come from FACTS. Never invent proof.
- Build on the PROVEN HOOKS where they fit and list the ids you used. Never cite an id that was not given.
- When revising, fix every point the editor raised; do not restart from scratch."""

EDITOR_SYSTEM = """You are the editor. Your job is to kill weak copy before it ships.
Score 1-10:
- ruthlessness_score: overall. 10 = every word earns its place; 8 = ship it; 5 = generic; 1 = brochure filler.
- directness: does it say the thing in the first line, in plain words?
- fluff_free: absence of filler, buzzwords, hedges, and throat-clearing.
Any filler sentence caps ruthlessness_score at 7. Any claim not backed by FACTS caps it at 5.
List every fluff phrase verbatim in fluff_found, every unbacked claim verbatim in unsupported_claims,
and concrete, imperative fixes ("Cut the first sentence", "Replace 'solutions' with what it does")."""

ADAPTER_SYSTEM = """You adapt an approved master message to one platform. Keep the message, the angle and
the CTA; change only form. Never add a claim, number or result that is not in FACTS or the master copy.
Obey the platform rules and the character limit exactly."""


def _bullets(items: list[str]) -> str:
    return "\n".join(f"- {x}" for x in items) or "- (none)"


# ── engine ──────────────────────────────────────────────────────────────────

class BlackOpsEngine:
    def __init__(self, settings: Settings, *, llm: LLM, memory: HookMemory | None = None):
        self.s = settings
        self.llm = llm
        self.memory = memory

    @classmethod
    def from_settings(cls, s: Settings, *, http_client: Any = None) -> "BlackOpsEngine":
        llm = LLM(s.llm_api_key, s.llm_base_url, timeout=s.llm_timeout_s,
                  max_retries=s.llm_max_retries, json_mode=s.json_mode, http_client=http_client)
        embedder = LLM(s.embedding_api_key, s.embedding_base_url, timeout=s.llm_timeout_s,
                       max_retries=s.llm_max_retries, http_client=http_client)
        memory: HookMemory
        if s.vector_backend == "pinecone":
            memory = PineconeHookMemory(embedder, s.embedding_model, api_key=s.pinecone_api_key or "",
                                        index_name=s.pinecone_index or "", namespace=s.pinecone_namespace)
        else:
            memory = FaissHookMemory(embedder, s.embedding_model, s.faiss_index_dir)
        return cls(s, llm=llm, memory=memory)

    async def aclose(self) -> None:
        await self.llm.aclose()
        if self.memory is not None:
            await self.memory._embedder.aclose()

    def extract_automation_block(self, response_text: str) -> dict | None:
        """Extract automation block from persona response."""
        # Look for automation block markers
        pattern = r'\[AUTOMATION_BLOCK\](.*?)\[/AUTOMATION_BLOCK\]'
        match = re.search(pattern, response_text, re.DOTALL)

        if match:
            try:
                block_content = match.group(1).strip()
                automation_data = json.loads(block_content)
                log.info("DEPLOYING AUTOMATION: %s", json.dumps(automation_data, indent=2))
                return automation_data
            except json.JSONDecodeError as e:
                log.warning("Failed to parse automation block JSON: %s", str(e))
                return None

        return None

    def process_response_for_automation(self, response_text: str) -> tuple[str, dict | None]:
        """Process response to separate explanatory text from automation instructions."""
        automation_data = self.extract_automation_block(response_text)

        # Remove the automation block from the response text for cleaner output
        clean_response = re.sub(r'\[AUTOMATION_BLOCK\].*?\[/AUTOMATION_BLOCK\]', '', response_text, flags=re.DOTALL).strip()

        return clean_response, automation_data

    def create_automation_instruction(self, target_url: str, action_type: str, selector: str = None, value: str = None) -> dict:
        """Create a structured automation instruction for Playwright execution."""
        if action_type.upper() not in ACTION_TYPES:
            raise ValueError(f"Invalid action type. Must be one of: {ACTION_TYPES}")

        instruction = {
            "target_url": target_url,
            "action": {
                "type": action_type.upper(),
                "selector": selector,
                "value": value
            }
        }

        # Remove None values
        instruction["action"] = {k: v for k, v in instruction["action"].items() if v is not None}

        return instruction

    def format_automation_block(self, automation_instruction: dict) -> str:
        """Format automation instruction as a block for persona responses."""
        if automation_instruction:
            block_json = json.dumps(automation_instruction, indent=2)
            return f"\n[AUTOMATION_BLOCK]\n{block_json}\n[/AUTOMATION_BLOCK]"
        return ""

    def parse_persona_output(self, response_text: str) -> dict:
        """
        Parse persona output to extract both natural language response and automation payload.

        Args:
            response_text (str): Complete persona response text

        Returns:
            dict: Dictionary containing 'response' (natural language) and 'automation_payload' (structured data)
        """
        # Extract automation block if present
        automation_payload = self.extract_automation_block(response_text)

        # Remove automation block from response text
        clean_response = re.sub(r'\[AUTOMATION_BLOCK\].*?\[/AUTOMATION_BLOCK\]', '', response_text, flags=re.DOTALL).strip()

        return {
            'response': clean_response,
            'automation_payload': automation_payload
        }

    # ── memory ──

    async def _retrieve_hooks(self, brief: Brief) -> list[Hook]:
        if self.memory is None:
            return []
        query = f"{brief.product}. {brief.audience}. {brief.offer}"
        try:
            return await self.memory.top_hooks(
                query, k=self.s.hook_top_k, min_similarity=self.s.hook_min_similarity
            )
        except EngineError as e:
            # A dead vector store degrades output; it should not block a campaign.
            log.warning("hook retrieval failed, continuing without hooks: %s", e)
            return []

    # ── strategy + editor gate ──

    def _check_strategy(self, st: Strategy, brief: Brief, hooks: list[Hook]) -> None:
        known = {h.id for h in hooks}
        invented = [i for i in st.hook_ids_used if i not in known]
        if invented:
            raise ValueError(f"hook_ids_used cites ids that were not provided: {invented}. Use only {sorted(known)}.")
        sources = brief.facts + [h.text for h in hooks] + [brief.offer]
        claims = unsupported_figures(f"{st.core_message}\n{st.master_copy}\n{st.cta}", sources)
        if claims:
            raise ValueError(f"figures not backed by FACTS: {claims}. Remove them or use only figures from FACTS.")

    def _strategist_prompt(self, brief: Brief, hooks: list[Hook],
                           previous: StrategyResult | None) -> str:
        parts = [
            f"PRODUCT: {brief.product}", f"AUDIENCE: {brief.audience}", f"OFFER: {brief.offer}",
            f"TONE: {brief.tone}", f"FACTS (the only claims allowed):\n{_bullets(brief.facts)}",
            "PROVEN HOOKS (id | performance | text):\n"
            + (_bullets([f"{h.id} | {h.performance:g} | {h.text}" for h in hooks]) if hooks else "- (none yet)"),
        ]
        if previous:
            v = previous.verdict
            fixes = list(v.fixes)
            if previous.fluff_hits or v.fluff_found:
                fixes.append(f"Cut these phrases entirely: {sorted(set(previous.fluff_hits + v.fluff_found))}")
            if v.unsupported_claims:
                fixes.append(f"Remove these unbacked claims: {v.unsupported_claims}")
            parts += [
                f"YOUR LAST DRAFT scored {previous.final_score}/10, needs {self.s.ruthlessness_threshold}:",
                previous.strategy.model_dump_json(indent=1),
                f"EDITOR'S FIXES (apply all):\n{_bullets(fixes)}",
            ]
        return "\n\n".join(parts)

    def _score(self, verdict: EditorVerdict, st: Strategy) -> tuple[int, list[str]]:
        """Editor's judgment, held to its own sub-scores and a deterministic fluff penalty
        so a lenient editor can't wave filler through."""
        fluff = find_fluff(f"{st.core_message}\n{st.master_copy}\n{st.cta}")
        score = min(verdict.ruthlessness_score, round((verdict.directness + verdict.fluff_free) / 2))
        return max(1, score - len(fluff)), fluff

    async def generate_strategy(self, brief: Brief) -> StrategyResult:
        hooks = await self._retrieve_hooks(brief)
        log.info("retrieved %d hooks", len(hooks))
        best: StrategyResult | None = None
        previous: StrategyResult | None = None
        for attempt in range(1, self.s.max_revisions + 2):
            strategy = await self.llm.complete_json(
                model=self.s.strategist_model, system=STRATEGIST_SYSTEM,
                user=self._strategist_prompt(brief, hooks, previous),
                schema=Strategy, temperature=0.8,
                validate=lambda st: self._check_strategy(st, brief, hooks),
            )
            verdict = await self.llm.complete_json(
                model=self.s.editor_model, system=EDITOR_SYSTEM,
                user=f"FACTS:\n{_bullets(brief.facts)}\n\nDRAFT:\n{strategy.model_dump_json(indent=1)}",
                schema=EditorVerdict, temperature=0.2,
            )
            score, fluff = self._score(verdict, strategy)
            result = StrategyResult(strategy, verdict, score, attempt, hooks, fluff)
            log.info("attempt %d: editor %d, final %d/10 (fluff=%s, unbacked=%s)",
                     attempt, verdict.ruthlessness_score, score, fluff, verdict.unsupported_claims)
            if best is None or score > best.final_score:
                best = result
            if score >= self.s.ruthlessness_threshold and not verdict.unsupported_claims:
                return result
            previous = result
        assert best is not None
        raise QualityGateFailed(best, self.s.ruthlessness_threshold)

    # ── concurrent platform adaptation ──

    async def _adapt(self, platform: str, st: Strategy, brief: Brief) -> Adaptation:
        spec = PLATFORMS[platform]
        sources = brief.facts + [st.master_copy, st.cta, brief.offer]

        def check(a: Adaptation) -> None:
            if a.platform != platform:
                a.platform = platform
            total = len(a.text) + sum(len(t) + 2 for t in a.hashtags)
            if total > spec.max_chars:
                raise ValueError(f"{total} chars including hashtags; limit is {spec.max_chars}. Cut it down.")
            claims = unsupported_figures(a.text, sources)
            if claims:
                raise ValueError(f"figures not in the master copy or FACTS: {claims}. Remove them.")

        return await self.llm.complete_json(
            model=self.s.adapter_model, system=ADAPTER_SYSTEM,
            user=(
                f"PLATFORM: {platform}\nRULES: {spec.rules}\nLIMIT: {spec.max_chars} characters including hashtags\n\n"
                f"FACTS:\n{_bullets(brief.facts)}\n\nMASTER COPY:\n{st.master_copy}\n\nCTA: {st.cta}\n"
                f"ANGLES: {', '.join(st.angles)}"
            ),
            schema=Adaptation, temperature=0.6, validate=check,
        )

    async def scale_content(self, result: StrategyResult, brief: Brief,
                            platforms: list[str] | None = None) -> ScaleResult:
        """Adapt the approved strategy to every platform at once.

        One platform failing (rate limit exhausted, never fits its limit) is
        reported in `failures`; the others still ship.
        """
        wanted = list(dict.fromkeys(platforms or brief.platforms))
        failures = {p: f"unknown platform; choose from {sorted(PLATFORMS)}" for p in wanted if p not in PLATFORMS}
        known = [p for p in wanted if p in PLATFORMS]
        sem = asyncio.Semaphore(self.s.max_concurrency)

        async def one(p: str) -> Adaptation:
            async with sem:
                return await self._adapt(p, result.strategy, brief)

        outcomes = await asyncio.gather(*(one(p) for p in known), return_exceptions=True)
        adaptations: dict[str, Adaptation] = {}
        for p, out in zip(known, outcomes):
            if isinstance(out, EngineError):
                log.warning("platform %s failed: %s", p, out)
                failures[p] = f"{type(out).__name__}: {out}"
            elif isinstance(out, BaseException):
                raise out  # a bug or a cancellation, not a platform failure — don't swallow it
            else:
                adaptations[p] = out
        return ScaleResult(adaptations, failures)

    async def run(self, brief: Brief, platforms: list[str] | None = None) -> tuple[StrategyResult, ScaleResult]:
        result = await self.generate_strategy(brief)
        return result, await self.scale_content(result, brief, platforms)


# ── CLI ─────────────────────────────────────────────────────────────────────

def _strategy_json(r: StrategyResult) -> dict[str, Any]:
    return {
        "strategy": r.strategy.model_dump(), "verdict": r.verdict.model_dump(),
        "final_score": r.final_score, "attempts": r.attempts,
        "hooks_used": [h.model_dump() for h in r.hooks if h.id in r.strategy.hook_ids_used],
    }


async def _main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    seed = sub.add_parser("seed", help="load hooks from a JSON array into hook memory")
    seed.add_argument("hooks_json", type=Path)
    run = sub.add_parser("run", help="generate a strategy from a brief and scale it")
    run.add_argument("brief_json", type=Path)
    run.add_argument("--platforms", nargs="+")
    args = ap.parse_args(argv)

    engine = BlackOpsEngine.from_settings(Settings.from_env())
    try:
        if args.cmd == "seed":
            hooks = [Hook.model_validate(h) for h in json.loads(args.hooks_json.read_text())]
            assert engine.memory is not None
            await engine.memory.add(hooks)
            print(json.dumps({"seeded": len(hooks)}))
            return 0
        brief = Brief.model_validate_json(args.brief_json.read_text())
        try:
            result, scaled = await engine.run(brief, args.platforms)
        except QualityGateFailed as e:
            print(json.dumps({"error": str(e), "best": _strategy_json(e.best)}, indent=2), file=sys.stderr)
            return 2
        print(json.dumps({
            **_strategy_json(result),
            "adaptations": {p: a.model_dump() for p, a in scaled.adaptations.items()},
            "failures": scaled.failures,
        }, indent=2))
        return 0 if not scaled.failures else 3
    except EngineError as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}), file=sys.stderr)
        return 1
    finally:
        await engine.aclose()


if __name__ == "__main__":
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    sys.exit(asyncio.run(_main(sys.argv[1:])))
