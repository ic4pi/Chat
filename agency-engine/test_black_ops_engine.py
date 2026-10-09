"""Drives the real OpenAI SDK through a scripted HTTP transport: no network, no keys.

Run: pytest -q test_black_ops_engine.py
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from pathlib import Path

import httpx2
import numpy as np
import pytest

import black_ops_engine as boe
from black_ops_engine import (
    BlackOpsEngine, Brief, FaissHookMemory, HallucinationError, Hook, LLM, LLMUnavailable,
    PineconeHookMemory, QualityGateFailed, Settings, find_fluff, unsupported_figures,
)

BRIEF = Brief(
    product="LedgerLite bookkeeping app",
    audience="solo contractors who hate doing their books",
    offer="14-day free trial",
    facts=["Users close their month in 20 minutes", "4.8 stars from 2,000 reviews"],
    platforms=["x", "linkedin", "email"],
)

GOOD_STRATEGY = {
    "positioning": "Bookkeeping for people who'd rather be working.",
    "pain_point": "Month-end eats a weekend.",
    "core_message": "Close your month in 20 minutes.",
    "hook_ids_used": [],
    "angles": ["time back", "no accountant needed"],
    "master_copy": "Your books take a weekend. They should take 20 minutes. LedgerLite does the sorting; you click approve.",
    "cta": "Start the 14-day free trial.",
}


def verdict(score: int, sub: int | None = None, **kw) -> dict:
    sub = score if sub is None else sub
    return {"ruthlessness_score": score, "directness": sub, "fluff_free": sub,
            "fluff_found": [], "unsupported_claims": [], "fixes": ["Cut the second sentence."], **kw}


def chat(content: str | dict) -> dict:
    text = content if isinstance(content, str) else json.dumps(content)
    return {"id": "x", "object": "chat.completion", "created": 0, "model": "m",
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": text}}]}


def fake_embedding(text: str, dim: int = 1024) -> list[float]:
    v = np.zeros(dim, dtype="float32")
    for w in re.findall(r"[a-z]+", text.lower()):
        v[int(hashlib.md5(w.encode()).hexdigest(), 16) % dim] += 1
    return v.tolist()


class Script:
    """Routes each request to a per-role queue of responses and records what was sent."""

    def __init__(self):
        self.queues: dict[str, list] = {"strategist": [], "editor": [], "adapter": [], "chat": []}
        self.requests: list[tuple[str, dict]] = []
        self.adapter_delay = 0.0
        self.adapter_by_platform: dict[str, list] = {}
        self.embed_status = 200

    @staticmethod
    def role(body: dict) -> str:
        sys_msg = body["messages"][0]["content"]
        if sys_msg.startswith("You are the strategist"):
            return "strategist"
        if sys_msg.startswith("You are the editor"):
            return "editor"
        if sys_msg.startswith("You adapt"):
            return "adapter"
        return "chat"

    async def __call__(self, req: httpx2.Request) -> httpx2.Response:
        body = json.loads(req.content)
        if req.url.path.endswith("/embeddings"):
            self.requests.append(("embed", body))
            if self.embed_status != 200:
                return httpx2.Response(self.embed_status, json={"error": {"message": "nope"}})
            data = [{"object": "embedding", "index": i, "embedding": fake_embedding(t)}
                    for i, t in enumerate(body["input"])]
            return httpx2.Response(200, json={"object": "list", "data": data, "model": "e",
                                              "usage": {"prompt_tokens": 1, "total_tokens": 1}})
        role = self.role(body)
        self.requests.append((role, body))
        if role == "adapter":
            await asyncio.sleep(self.adapter_delay)
            platform = re.search(r"PLATFORM: (\w+)", body["messages"][1]["content"]).group(1)
            q = self.adapter_by_platform.get(platform)
            item = q.pop(0) if q and len(q) > 1 else (q[0] if q else
                   {"platform": platform, "text": f"{platform}: Your books, 20 minutes. Start the 14-day free trial.", "hashtags": []})
        else:
            item = self.queues[role].pop(0)
        if isinstance(item, httpx2.Response):
            return item
        return httpx2.Response(200, json=chat(item))

    def bodies(self, role: str) -> list[dict]:
        return [b for r, b in self.requests if r == role]


def make_settings(tmp_path: Path, **kw) -> Settings:
    base = dict(llm_api_key="k", llm_base_url="http://llm.test/v1", strategist_model="strat",
                editor_model="ed", adapter_model="ad", embedding_api_key="k",
                embedding_base_url="http://llm.test/v1", embedding_model="emb",
                faiss_index_dir=tmp_path / "idx", max_revisions=2, llm_max_retries=2)
    base.update(kw)
    return Settings(**base)


def make_engine(tmp_path: Path, script: Script, **kw) -> BlackOpsEngine:
    client = httpx2.AsyncClient(transport=httpx2.MockTransport(script))
    return BlackOpsEngine.from_settings(make_settings(tmp_path, **kw), http_client=client)


def run(coro):
    return asyncio.run(coro)


# ── grounding helpers ──

def test_unsupported_figures_flags_invented_numbers_only():
    facts = ["Users close their month in 20 minutes", "4.8 stars from 2,000 reviews"]
    assert unsupported_figures("Close in 20 minutes. 4.8 stars, 2000 reviews.", facts) == []
    assert unsupported_figures("Save 300% more and $5,000 a year", facts) == ["$5,000", "300%"]
    assert unsupported_figures("3 steps, launched in 2026", facts) == []  # structure and dates


def test_find_fluff():
    assert find_fluff("Unlock a seamless, game-changer journey") == ["game-changer", "journey", "seamless", "unlock"]
    assert find_fluff("Your books take a weekend.") == []


# ── error handling ──

def test_rate_limit_honours_retry_after_then_succeeds(tmp_path):
    s = Script()
    s.queues["chat"] = [httpx2.Response(429, headers={"retry-after": "0"}, json={"error": {"message": "slow down"}}),
                        httpx2.Response(429, headers={"retry-after-ms": "10"}, json={"error": {"message": "slow down"}}),
                        {"answer": "ok"}]
    llm = LLM("k", "http://llm.test/v1", max_retries=3,
              http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(s)))

    class Out(boe.BaseModel):
        answer: str

    t = time.monotonic()
    out = run(llm.complete_json(model="m", system="sys", user="u", schema=Out))
    assert out.answer == "ok" and len(s.bodies("chat")) == 3
    assert time.monotonic() - t < 2  # used the server's hint, not exponential backoff


def test_server_errors_exhaust_retries(tmp_path):
    s = Script()
    s.queues["chat"] = [httpx2.Response(503, headers={"retry-after": "0"}, json={"error": {"message": "down"}})] * 3

    class Out(boe.BaseModel):
        answer: str

    llm = LLM("k", "http://llm.test/v1", max_retries=2,
              http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(s)))
    with pytest.raises(LLMUnavailable, match="gave up after 3 tries"):
        run(llm.complete_json(model="m", system="sys", user="u", schema=Out))


def test_auth_error_is_not_retried(tmp_path):
    s = Script()
    s.queues["chat"] = [httpx2.Response(401, json={"error": {"message": "bad key"}})]

    class Out(boe.BaseModel):
        answer: str

    llm = LLM("k", "http://llm.test/v1", max_retries=5,
              http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(s)))
    with pytest.raises(LLMUnavailable, match="HTTP 401"):
        run(llm.complete_json(model="m", system="sys", user="u", schema=Out))
    assert len(s.bodies("chat")) == 1


def test_malformed_json_is_repaired_with_the_reason(tmp_path):
    s = Script()
    s.queues["chat"] = ["Sure! Here's your answer: it's ok", '```json\n{"answer": "ok"}\n```']

    class Out(boe.BaseModel):
        answer: str

    llm = LLM("k", "http://llm.test/v1", http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(s)))
    assert run(llm.complete_json(model="m", system="sys", user="u", schema=Out)).answer == "ok"
    repair = s.bodies("chat")[1]["messages"][-1]["content"]
    assert repair.startswith("Rejected: no JSON object")


def test_response_format_unsupported_falls_back(tmp_path):
    s = Script()
    s.queues["chat"] = [httpx2.Response(400, json={"error": {"message": "response_format is not supported"}}),
                        {"answer": "ok"}]

    class Out(boe.BaseModel):
        answer: str

    llm = LLM("k", "http://llm.test/v1", http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(s)))
    assert run(llm.complete_json(model="m", system="sys", user="u", schema=Out)).answer == "ok"
    first, second = s.bodies("chat")
    assert "response_format" in first and "response_format" not in second and llm.json_mode is False


# ── critique loop ──

def test_editor_sends_weak_draft_back_with_fixes(tmp_path):
    s = Script()
    s.queues["strategist"] = [GOOD_STRATEGY, GOOD_STRATEGY]
    s.queues["editor"] = [verdict(6, fixes=["Lead with the weekend, not the app."]), verdict(9)]
    eng = make_engine(tmp_path, s)
    r = run(eng.generate_strategy(BRIEF))
    assert r.attempts == 2 and r.final_score == 9
    revision_prompt = s.bodies("strategist")[1]["messages"][1]["content"]
    assert "YOUR LAST DRAFT scored 6/10, needs 8" in revision_prompt
    assert "Lead with the weekend, not the app." in revision_prompt


def test_gate_fails_loudly_with_best_draft(tmp_path):
    s = Script()
    s.queues["strategist"] = [GOOD_STRATEGY] * 3
    s.queues["editor"] = [verdict(5), verdict(7), verdict(6)]
    eng = make_engine(tmp_path, s)  # max_revisions=2 → 3 attempts
    with pytest.raises(QualityGateFailed) as ei:
        run(eng.generate_strategy(BRIEF))
    assert ei.value.best.final_score == 7 and ei.value.best.attempts == 2


def test_lenient_editor_cannot_pass_fluff(tmp_path):
    s = Script()
    fluffy = {**GOOD_STRATEGY, "master_copy": "Unlock seamless bookkeeping. Close your month in 20 minutes and get your weekend back."}
    s.queues["strategist"] = [fluffy, GOOD_STRATEGY]
    s.queues["editor"] = [verdict(9), verdict(9)]
    eng = make_engine(tmp_path, s)
    r = run(eng.generate_strategy(BRIEF))
    assert r.attempts == 2  # 9 - 2 fluff hits = 7 < 8 → sent back
    assert "Cut these phrases entirely: ['seamless', 'unlock']" in s.bodies("strategist")[1]["messages"][1]["content"]


def test_editor_cannot_score_above_its_own_subscores(tmp_path):
    s = Script()
    s.queues["strategist"] = [GOOD_STRATEGY, GOOD_STRATEGY]
    s.queues["editor"] = [verdict(10, sub=6), verdict(9)]
    assert run(make_engine(tmp_path, s).generate_strategy(BRIEF)).attempts == 2


def test_unbacked_claim_flagged_by_editor_blocks_approval(tmp_path):
    s = Script()
    s.queues["strategist"] = [GOOD_STRATEGY, GOOD_STRATEGY]
    s.queues["editor"] = [verdict(9, unsupported_claims=["trusted by accountants"]), verdict(9)]
    assert run(make_engine(tmp_path, s).generate_strategy(BRIEF)).attempts == 2


# ── hallucination guards ──

def test_invented_statistic_is_rejected_before_the_editor_sees_it(tmp_path):
    s = Script()
    lying = {**GOOD_STRATEGY, "master_copy": "Contractors save 300% more time and $5,000 a year. Close your month in 20 minutes."}
    s.queues["strategist"] = [lying, GOOD_STRATEGY]
    s.queues["editor"] = [verdict(9)]
    r = run(make_engine(tmp_path, s).generate_strategy(BRIEF))
    assert r.strategy.master_copy == GOOD_STRATEGY["master_copy"]
    repair = s.bodies("strategist")[1]["messages"][-1]["content"]
    assert "$5,000" in repair and "300%" in repair
    assert len(s.bodies("editor")) == 1


def test_invented_hook_id_is_rejected(tmp_path):
    s = Script()
    s.queues["strategist"] = [{**GOOD_STRATEGY, "hook_ids_used": ["h999"]}, GOOD_STRATEGY]
    s.queues["editor"] = [verdict(9)]
    run(make_engine(tmp_path, s).generate_strategy(BRIEF))
    assert "h999" in s.bodies("strategist")[1]["messages"][-1]["content"]


def test_persistent_hallucination_raises(tmp_path):
    s = Script()
    s.queues["strategist"] = [{**GOOD_STRATEGY, "master_copy": "Save 90% of your time, guaranteed, every single month."}] * 3
    with pytest.raises(HallucinationError):
        run(make_engine(tmp_path, s).generate_strategy(BRIEF))


# ── concurrent scaling ──

def test_scale_runs_platforms_concurrently_and_isolates_failures(tmp_path):
    s = Script()
    s.adapter_delay = 0.4
    s.adapter_by_platform["x"] = [{"platform": "x", "text": "x" * 400, "hashtags": []}]  # never fits 280
    eng = make_engine(tmp_path, s)
    result = boe.StrategyResult(boe.Strategy(**GOOD_STRATEGY), boe.EditorVerdict(**verdict(9)), 9, 1, [])
    t = time.monotonic()
    out = run(eng.scale_content(result, BRIEF, ["x", "linkedin", "email", "instagram", "myspace"]))
    elapsed = time.monotonic() - t
    assert set(out.adaptations) == {"linkedin", "email", "instagram"}
    assert "HallucinationError" in out.failures["x"] and "unknown platform" in out.failures["myspace"]
    # 3 x-attempts run sequentially (0.4s each) while the others finish in parallel.
    assert elapsed < 1.6, elapsed
    x_repair = [b for b in s.bodies("adapter") if "PLATFORM: x" in b["messages"][1]["content"]][1]
    assert "limit is 280" in x_repair["messages"][-1]["content"]


def test_concurrency_is_bounded(tmp_path):
    s = Script()
    s.adapter_delay = 0.3
    eng = make_engine(tmp_path, s, max_concurrency=2)
    result = boe.StrategyResult(boe.Strategy(**GOOD_STRATEGY), boe.EditorVerdict(**verdict(9)), 9, 1, [])
    t = time.monotonic()
    out = run(eng.scale_content(result, BRIEF, ["x", "linkedin", "email", "instagram"]))
    assert len(out.adaptations) == 4 and time.monotonic() - t >= 0.6  # 2 waves of 2


# ── memory ──

HOOKS = [
    Hook(id="h1", text="Stop losing weekends to bookkeeping", platform="any", performance=0.09),
    Hook(id="h2", text="Your accountant charges for bookkeeping you could finish in minutes", performance=0.14),
    Hook(id="h3", text="Best hiking boots for wet trails", performance=0.50),
]


def test_faiss_retrieves_relevant_hooks_ranked_by_performance_and_persists(tmp_path):
    s = Script()
    eng = make_engine(tmp_path, s)
    run(eng.memory.add(HOOKS))
    top = run(eng.memory.top_hooks("bookkeeping weekends contractors", k=5, min_similarity=0.15))
    assert [h.id for h in top] == ["h2", "h1"]  # hiking hook is irrelevant despite top performance

    run(eng.memory.add([HOOKS[0].model_copy(update={"performance": 0.30})]))  # metadata-only update
    reloaded = FaissHookMemory(eng.memory._embedder, "emb", tmp_path / "idx")
    assert reloaded._index.ntotal == 3
    top = run(reloaded.top_hooks("bookkeeping weekends contractors", k=5, min_similarity=0.15))
    assert [h.id for h in top] == ["h1", "h2"]


def test_strategist_receives_hooks_and_may_cite_them(tmp_path):
    s = Script()
    s.queues["strategist"] = [{**GOOD_STRATEGY, "hook_ids_used": ["h1"]}]
    s.queues["editor"] = [verdict(9)]
    eng = make_engine(tmp_path, s, hook_min_similarity=0.1)
    run(eng.memory.add(HOOKS))
    r = run(eng.generate_strategy(BRIEF))
    prompt = s.bodies("strategist")[0]["messages"][1]["content"]
    assert "h1 | 0.09 | Stop losing weekends" in prompt and "hiking" not in prompt
    assert r.strategy.hook_ids_used == ["h1"]


def test_vector_store_outage_degrades_instead_of_failing(tmp_path):
    s = Script()
    s.queues["strategist"] = [GOOD_STRATEGY]
    s.queues["editor"] = [verdict(9)]
    eng = make_engine(tmp_path, s, hook_min_similarity=0.1)
    run(eng.memory.add(HOOKS))
    s.embed_status = 401
    r = run(eng.generate_strategy(BRIEF))
    assert r.hooks == [] and "PROVEN HOOKS (id | performance | text):\n- (none yet)" in s.bodies("strategist")[0]["messages"][1]["content"]


def test_pinecone_memory_against_fake_index(tmp_path):
    class FakeIndex:
        def __init__(self):
            self.rows = {}

        def upsert(self, vectors, namespace):
            for v in vectors:
                self.rows[v["id"]] = v

        def query(self, vector, top_k, include_metadata, namespace, filter):
            q = np.asarray(vector)
            scored = []
            for v in self.rows.values():
                if filter and v["metadata"]["platform"] not in filter["platform"]["$in"]:
                    continue
                scored.append({"id": v["id"], "score": float(np.dot(q, v["values"])), "metadata": v["metadata"]})
            return {"matches": sorted(scored, key=lambda m: -m["score"])[:top_k]}

    s = Script()
    embedder = LLM("k", "http://llm.test/v1", http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(s)))
    mem = PineconeHookMemory(embedder, "emb", index=FakeIndex())
    run(mem.add(HOOKS + [Hook(id="h4", text="bookkeeping weekends on linkedin only", platform="linkedin", performance=0.9)]))
    top = run(mem.top_hooks("bookkeeping weekends contractors", k=5, platform="x", min_similarity=0.15))
    assert [h.id for h in top] == ["h2", "h1"]  # linkedin-only hook filtered out for x


def test_settings_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("LLM_API_KEY", "k")
    monkeypatch.setenv("LLM_MODEL", "m")
    monkeypatch.setenv("EDITOR_MODEL", "judge")
    s = Settings.from_env()
    assert (s.strategist_model, s.editor_model, s.embedding_api_key) == ("m", "judge", "k")
    monkeypatch.setenv("VECTOR_BACKEND", "pinecone")
    with pytest.raises(boe.ConfigError, match="PINECONE_API_KEY"):
        Settings.from_env()
