/**
 * End-to-end pipeline verification.
 *
 * Test 1 — SUCCESSFUL code:
 *   1. Open the integrated chat+terminal app.
 *   2. Enable auto-run if not already on.
 *   3. Send "write a streaming Python script".
 *   4. Wait for the mock LLM response (contains a Python code block).
 *   5. Auto-run fires → POST /run-code → sandbox-runner streams output.
 *   6. Verify output lines appear in the xterm buffer incrementally.
 *   7. Screenshot mid-run and at completion.
 *
 * Test 2 — FAILING code:
 *   1. Send "write code that errors out".
 *   2. Mock LLM returns code that imports a non-existent module.
 *   3. Auto-run → Python exits non-zero with traceback.
 *   4. Verify the error is rendered cleanly (not a silent hang).
 *   5. Screenshot the terminal showing the error.
 */

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import * as fs from 'fs';

const CHROME  = '/usr/bin/google-chrome-stable';
const APP_URL = 'http://localhost:5173';
const OUT_DIR = '/tmp/pipeline-verify';

fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function readBuffer(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const term = window.__sandboxTerm;
    if (!term) return [];
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const t = buf.getLine(i)?.translateToString(true).trimEnd() ?? '';
      if (t) lines.push(t);
    }
    return lines;
  });
}

async function waitForTerminalLine(page: Page, predicate: (l: string) => boolean, ms = 20_000) {
  await page.waitForFunction(
    (pred: string) => {
      const term = window.__sandboxTerm;
      if (!term) return false;
      const buf = term.buffer.active;
      const fn = new Function('l', `return (${pred})(l)`) as (l: string) => boolean;
      for (let i = 0; i < buf.length; i++) {
        const t = buf.getLine(i)?.translateToString(true).trimEnd() ?? '';
        if (fn(t)) return true;
      }
      return false;
    },
    { timeout: ms },
    predicate.toString(),
  );
}

async function runTest(
  page: Page,
  label: string,
  chatMsg: string,
  checks: {
    midRun?: (lines: string[]) => { pass: boolean; note: string };
    final:   (lines: string[]) => { pass: boolean; note: string };
    waitFor:  (l: string) => boolean;
  },
  snapPrefix: string,
): Promise<boolean> {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`TEST: ${label}`);
  console.log('═'.repeat(60));

  // Clear terminal
  const clearBtn = await page.$('button:not([data-testid])');
  // Actually look for the "Clear" button by its text via evaluate
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const clear = btns.find(b => b.textContent?.trim() === 'Clear');
    clear?.click();
  });
  await sleep(300);

  // Type chat message
  console.log(`Sending: "${chatMsg}"`);
  await page.click('#chat-input');
  await page.evaluate(() => {
    const el = document.getElementById('chat-input') as HTMLInputElement | null;
    if (el) { el.value = ''; }
  });
  await page.type('#chat-input', chatMsg);
  await page.keyboard.press('Enter');

  const t0 = Date.now();

  // Wait for LLM response + code block to appear
  console.log('Waiting for LLM response…');
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="run-code-btn"]'),
    { timeout: 15_000 }
  );
  console.log(`[+${((Date.now()-t0)/1000).toFixed(1)}s] Code block appeared in chat.`);

  // Wait briefly for auto-run to fire
  await sleep(800);

  // Mid-run snapshot (if requested)
  let midPass = true;
  if (checks.midRun) {
    const lines = await readBuffer(page);
    const r = checks.midRun(lines);
    midPass = r.pass;
    const snap = `${OUT_DIR}/${snapPrefix}-mid.png`;
    await page.screenshot({ path: snap });
    console.log(`[+${((Date.now()-t0)/1000).toFixed(1)}s] Mid-run screenshot → ${snap}`);
    console.log('  ' + r.note + (r.pass ? ' ✓' : ' ✗'));
  }

  // Wait for completion
  console.log('Waiting for completion…');
  await waitForTerminalLine(page, checks.waitFor, 20_000);
  await sleep(500);

  const finalLines = await readBuffer(page);
  const fr = checks.final(finalLines);
  const snap = `${OUT_DIR}/${snapPrefix}-final.png`;
  await page.screenshot({ path: snap });
  console.log(`[+${((Date.now()-t0)/1000).toFixed(1)}s] Final screenshot → ${snap}`);
  console.log('\nTerminal output:');
  console.log('─'.repeat(60));
  finalLines.forEach(l => console.log('  ' + l));
  console.log('─'.repeat(60));
  console.log('  ' + fr.note + (fr.pass ? ' ✓' : ' ✗'));

  const pass = midPass && fr.pass;
  console.log(`\nResult: ${pass ? 'PASS ✓' : 'FAIL ✗'}`);
  return pass;
}

async function main() {
  console.log('Starting Puppeteer…');
  let browser: Browser | null = null;
  let test1Pass = false, test2Pass = false;

  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1600,900'],
      defaultViewport: { width: 1600, height: 900 },
    });

    const page = await browser.newPage();
    page.on('pageerror', e => console.warn('[browser]', e.message));

    console.log(`Opening ${APP_URL}…`);
    await page.goto(APP_URL, { waitUntil: 'networkidle0', timeout: 30_000 });
    await page.waitForSelector('[data-testid="terminal"] .xterm', { timeout: 10_000 });
    await sleep(800);

    // Make sure auto-run is ON
    const autoRunChecked = await page.$eval('[data-testid="autorun-toggle"]',
      (el: Element) => (el as HTMLInputElement).checked);
    if (!autoRunChecked) {
      await page.click('[data-testid="autorun-toggle"]');
      await sleep(200);
    }
    console.log('Auto-run: ON');

    // ── TEST 1: successful streaming Python code ───────────────────────────
    test1Pass = await runTest(
      page,
      'Successful streaming Python script',
      'write a streaming Python script',
      {
        midRun: (lines) => {
          // During the 0.5s sleep between items, some lines should be
          // present but not all 5 tasks.
          const taskLines = lines.filter(l => /\[\d\/5\]/.test(l));
          return {
            pass: taskLines.length >= 1,
            note: `Streaming in progress — ${taskLines.length} task line(s) visible mid-run`,
          };
        },
        waitFor: (l) => l.includes('All tasks complete'),
        final: (lines) => {
          const allTasks = [1,2,3,4,5].every(n =>
            lines.some(l => l.includes(`[${n}/5]`)));
          const done = lines.some(l => l.includes('All tasks complete'));
          const exited = lines.some(l => l.includes('[exit 0]'));
          return {
            pass: allTasks && done && exited,
            note: [
              `All 5 task lines: ${allTasks}`,
              `"All tasks complete": ${done}`,
              `[exit 0]: ${exited}`,
            ].join(' | '),
          };
        },
      },
      '01-success',
    );

    // ── TEST 2: failing code with ImportError ─────────────────────────────
    test2Pass = await runTest(
      page,
      'Failing code (ImportError) — must show error, not hang',
      'write code that errors out',
      {
        waitFor: (l) => l.includes('[exit') || l.includes('Error') || l.includes('✗'),
        final: (lines) => {
          const hasError = lines.some(l =>
            /ModuleNotFoundError|ImportError|No module named|✗/.test(l));
          const noHang = lines.some(l => l.includes('[exit') || l.includes('✗'));
          return {
            pass: hasError && noHang,
            note: `Error shown: ${hasError} | Stream ended (no hang): ${noHang}`,
          };
        },
      },
      '02-error',
    );

    // ── Summary ──────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(60));
    console.log('PIPELINE RESULTS');
    console.log('═'.repeat(60));
    console.log(`  Test 1 (success code)  : ${test1Pass ? 'PASS ✓' : 'FAIL ✗'}`);
    console.log(`  Test 2 (failing code)  : ${test2Pass ? 'PASS ✓' : 'FAIL ✗'}`);
    console.log(`  Screenshots in         : ${OUT_DIR}/`);
    console.log('═'.repeat(60));

    process.exit(test1Pass && test2Pass ? 0 : 1);

  } finally {
    await browser?.close();
  }
}

main().catch(err => { console.error('verify-pipeline failed:', err); process.exit(1); });
