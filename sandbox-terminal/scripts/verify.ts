/**
 * Puppeteer verification script.
 *
 * Proves incremental streaming by:
 *   1. Opening the sandbox-terminal page.
 *   2. Typing a command that outputs MARKER_A, sleeps 2 s, then outputs MARKER_B.
 *   3. Taking a screenshot + buffer read at ~1.8 s:
 *        MARKER_A must be visible as output, MARKER_B must NOT yet.
 *   4. Waiting for the command to finish, then screenshot + buffer read:
 *        Both markers and [exit 0] must be visible.
 *
 * "Exact-line" matching avoids false positives: the marker also appears in
 * the command-invocation line ("$ echo MARKER_A && ..."). We test that a line
 * trimmed to exactly MARKER_A exists — that can only be the real output.
 */

import puppeteer, { type Browser } from 'puppeteer-core';
import * as fs from 'fs';

const CHROME  = process.env['CHROME_PATH'] ?? '/usr/bin/google-chrome-stable';
const APP_URL = process.env['APP_URL']     ?? 'http://localhost:5173';
const OUT_DIR = '/tmp/sandbox-verify';

const MARKER_A = 'STREAM_LINE_A';
const MARKER_B = 'STREAM_LINE_B';

fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Read every line in the active xterm buffer, return as newline-joined string.
async function readBuffer(page: puppeteer.Page): Promise<string> {
  return page.evaluate(() => {
    const term = window.__sandboxTerm;
    if (!term) return '(terminal not found)';
    const buf = term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      out.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    return out.join('\n');
  });
}

// True if the buffer contains a line that trims to exactly `marker`.
// This distinguishes real output from the command-invocation echo line.
function hasExactLine(text: string, marker: string): boolean {
  return text.split('\n').some(l => l.trimEnd() === marker);
}

async function main() {
  console.log('Starting Puppeteer…');
  let browser: Browser | null = null;

  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800'],
      defaultViewport: { width: 1280, height: 800 },
    });

    const page = await browser.newPage();
    page.on('pageerror', e => console.warn('[browser error]', e.message));

    // ── 1. Load app ───────────────────────────────────────────────────────
    console.log(`Opening ${APP_URL} …`);
    await page.goto(APP_URL, { waitUntil: 'networkidle0', timeout: 30_000 });
    await page.waitForSelector('[data-testid="terminal"] .xterm', { timeout: 10_000 });
    await sleep(600); // let FitAddon settle

    // ── 2. Type the slow command ──────────────────────────────────────────
    const CMD = `echo "${MARKER_A}" && sleep 2 && echo "${MARKER_B}"`;
    console.log(`Typing command: ${CMD}`);
    await page.click('#cmd-input');
    await page.type('#cmd-input', CMD);

    // ── 3. Click Run ──────────────────────────────────────────────────────
    console.log('Clicking Run…');
    // Wait until button is enabled (input is non-empty → button enabled)
    await page.waitForFunction(
      () => {
        const btn = document.querySelector<HTMLButtonElement>('button:not([title="Clear terminal"])');
        return btn && !btn.disabled;
      },
      { timeout: 5_000 }
    );
    await page.click('button:not([title="Clear terminal"]):not([disabled])');

    const t0 = Date.now();

    // ── 4. Mid-stream screenshot (inside the 2 s sleep) ───────────────────
    await sleep(1800);

    const snap1 = `${OUT_DIR}/01-mid-stream.png`;
    await page.screenshot({ path: snap1 });
    const buf1 = await readBuffer(page);
    const lines1 = buf1.split('\n').map(l => l.trimEnd());
    const gotA1  = hasExactLine(buf1, MARKER_A);
    const gotB1  = hasExactLine(buf1, MARKER_B);

    console.log(`\n[+${((Date.now()-t0)/1000).toFixed(1)}s] Screenshot 1 → ${snap1}`);
    console.log('Buffer at this moment:');
    console.log('─'.repeat(60));
    lines1.filter(Boolean).forEach(l => console.log('  ' + l));
    console.log('─'.repeat(60));
    console.log(`  ${MARKER_A} as output line : ${gotA1 ? 'YES ✓' : 'NO ✗'}`);
    console.log(`  ${MARKER_B} NOT yet        : ${!gotB1 ? 'YES ✓' : 'NO ✗  (FAIL — buffered)'}`);

    // ── 5. Wait for completion and final screenshot ───────────────────────
    await page.waitForFunction(
      (marker: string) => {
        const term = window.__sandboxTerm;
        if (!term) return false;
        const buf = term.buffer.active;
        for (let i = 0; i < buf.length; i++) {
          if ((buf.getLine(i)?.translateToString(true) ?? '').trimEnd() === marker) return true;
        }
        return false;
      },
      { timeout: 15_000 },
      MARKER_B,
    );
    await sleep(600); // let exit line render

    const snap2 = `${OUT_DIR}/02-complete.png`;
    await page.screenshot({ path: snap2 });
    const buf2  = await readBuffer(page);
    const lines2 = buf2.split('\n').map(l => l.trimEnd());
    const gotB2  = hasExactLine(buf2, MARKER_B);
    const gotExit = lines2.some(l => l.includes('[exit 0]'));

    console.log(`\n[+${((Date.now()-t0)/1000).toFixed(1)}s] Screenshot 2 → ${snap2}`);
    console.log('Buffer at completion:');
    console.log('─'.repeat(60));
    lines2.filter(Boolean).forEach(l => console.log('  ' + l));
    console.log('─'.repeat(60));
    console.log(`  ${MARKER_B} now visible : ${gotB2  ? 'YES ✓' : 'NO ✗'}`);
    console.log(`  [exit 0] visible  : ${gotExit ? 'YES ✓' : 'NO ✗'}`);

    // ── 6. Result ─────────────────────────────────────────────────────────
    const pass = gotA1 && !gotB1 && gotB2 && gotExit;
    console.log('\n' + '═'.repeat(60));
    if (pass) {
      console.log('  RESULT: PASS ✓  Streaming is incremental — output arrived live.');
    } else {
      console.log('  RESULT: FAIL ✗  Output did not stream incrementally.');
      if (!gotA1)   console.log(`    – ${MARKER_A} never appeared as real output`);
      if (gotB1)    console.log(`    – ${MARKER_B} appeared before the sleep finished (buffered)`);
      if (!gotB2)   console.log(`    – ${MARKER_B} missing after command finished`);
      if (!gotExit) console.log('    – [exit 0] missing');
    }
    console.log('═'.repeat(60));
    process.exit(pass ? 0 : 1);

  } finally {
    await browser?.close();
  }
}

main().catch(err => { console.error('verify failed:', err); process.exit(1); });
