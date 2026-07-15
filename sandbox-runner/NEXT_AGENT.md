# Real Vercel Sandbox execution — VERIFIED ✓

The pipeline was verified with real Vercel Sandbox (Firecracker microVM) execution.
All Puppeteer tests passed on 2026-07-15.

## Verification run results

Both tests passed with `verify-pipeline.ts` (Puppeteer end-to-end):

```
════════════════════════════════════════════════════════════
PIPELINE RESULTS
════════════════════════════════════════════════════════════
  Test 1 (success code)  : PASS ✓
  Test 2 (failing code)  : PASS ✓
════════════════════════════════════════════════════════════
```

### Test 1 — successful streaming Python script

Terminal output confirmed real sandbox:

```
▶ Running python snippet…
[Creating sandbox…]
[Sandbox ready: amber-typical-mole-cLq8do]   ← real Firecracker microVM
[1/5] Initialising...
[2/5] Loading data...
[3/5] Processing...
[4/5] Analysing...
[5/5] Done...

All tasks complete.
[exit 0]
```

All 5 task lines streamed incrementally ✓  |  "All tasks complete" ✓  |  `[exit 0]` ✓

### Test 2 — failing code (ImportError)

```
▶ Running python snippet…
[Creating sandbox…]
[Sandbox ready: amber-tasty-kiwi-KprV3f]   ← real Firecracker microVM
Traceback (most recent call last):
  File "/vercel/sandbox/code.py", line 1, in <module>
    import definitely_not_a_real_module
ModuleNotFoundError: No module named 'definitely_not_a_real_module'
[exit 1]
```

Error surfaced cleanly (no hang) ✓

## How to re-run

```bash
# Terminal 1 — backend (real sandbox, mock LLM)
cd sandbox-runner
LOCAL_CHAT_MODE=true node --experimental-strip-types src/server.ts
# Expected: "Auth: credentials found ✓"

# Terminal 2 — frontend
cd sandbox-terminal
npx vite

# Terminal 3 — verify
cd sandbox-terminal
LOCAL_CHAT_MODE=true node --experimental-strip-types scripts/verify-pipeline.ts
```

Requires secrets: `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`
