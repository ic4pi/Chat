# Next agent task — verify real Vercel Sandbox execution

The previous agent session ended because VERCEL_TOKEN, VERCEL_TEAM_ID, and
VERCEL_PROJECT_ID were added to Cursor secrets after this VM started, so they
weren't injected.

## What to do immediately on startup

1. Confirm the three secrets are now available:
   ```bash
   printenv | grep VERCEL_TOKEN && printenv | grep VERCEL_TEAM_ID && printenv | grep VERCEL_PROJECT_ID
   ```

2. Start the sandbox-runner backend WITHOUT LOCAL_MODE (real Vercel Sandbox):
   ```bash
   cd sandbox-runner
   node --experimental-strip-types src/server.ts
   ```
   Expected startup output: "Auth: credentials found ✓"

3. Start the frontend:
   ```bash
   cd sandbox-terminal
   npx vite
   ```

4. Run the pipeline verification (LOCAL_CHAT_MODE still on for the mock LLM,
   but the sandbox execution itself is now real):
   ```bash
   cd sandbox-terminal
   LOCAL_CHAT_MODE=true node --experimental-strip-types scripts/verify-pipeline.ts
   ```

5. The terminal output should say:
     [status] Creating sandbox…
     [status] Sandbox ready: sandbox-<name>
   NOT:
     [LOCAL_MODE] python3 ...

   That confirms code is running inside a real Firecracker microVM, not locally.

## What was already done

- sandbox-runner/src/server.ts has full Vercel Sandbox support on the else branch
  (LOCAL_MODE unset path): Sandbox.create() → sandbox.writeFiles() → sandbox.runCommand()
  → command.logs() streamed as SSE.
- sandbox-terminal/ has a full React+xterm.js UI, ChatPane with code extraction,
  and a Puppeteer verify script.
- Both LOCAL_MODE tests passed previously (see git log).

## Success criteria

- Both Puppeteer tests pass (PASS ✓ for success code AND failing code).
- Screenshots show "Sandbox ready: sandbox-XXX" in the terminal, not [LOCAL_MODE].
- The verify-pipeline script exits 0.
