/**
 * A local stand-in for @vercel/sandbox.
 *
 * Same surface the sandbox API handlers use (runCommand / writeFiles /
 * domain / extendTimeout / name), backed by a real temp directory and real
 * child processes. Absolute sandbox paths are rewritten into that directory,
 * so handler code runs completely unmodified.
 *
 * This exists so `npm run check:workspace` can drive the whole
 * build-an-app pipeline — including a real dev server and a real browser —
 * without Vercel Sandbox credentials.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SANDBOX_PREFIX = '/vercel/sandbox';
const TMP_PREFIX = '/tmp/.';

const registry = new Map();

function rewrite(text, root) {
  return String(text)
    .split(SANDBOX_PREFIX).join(root)
    .split(TMP_PREFIX).join(path.join(root, 'tmp') + path.sep + '.');
}

/**
 * Map local paths back to the sandbox paths a real VM would print. Handlers
 * derive relative paths by stripping REPO_DIR from command output, so output
 * has to look like it came from /vercel/sandbox.
 */
function unrewrite(text, root) {
  return String(text)
    .split(path.join(root, 'tmp') + path.sep + '.').join(TMP_PREFIX)
    .split(root).join(SANDBOX_PREFIX);
}

class LocalSandbox {
  constructor(name) {
    this.name = name;
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), `ws-sandbox-${name}-`));
    fs.mkdirSync(path.join(this.root, 'tmp'), { recursive: true });
    this.children = [];
  }

  domain(port) {
    return `http://127.0.0.1:${port}`;
  }

  async extendTimeout() { /* no lifetime to extend locally */ }

  async writeFiles(files) {
    for (const f of files) {
      const abs = rewrite(f.path, this.root);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content);
    }
  }

  runCommand({ cmd, args = [] }) {
    const mappedArgs = args.map(a => rewrite(a, this.root));
    const child = spawn(rewrite(cmd, this.root), mappedArgs, {
      cwd: this.root,
      env: { ...process.env, HOME: this.root },
    });
    this.children.push(child);

    return new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', reject);
      child.on('close', code => {
        resolve({
          exitCode: code ?? 0,
          stdout: async () => unrewrite(out, this.root),
          stderr: async () => unrewrite(err, this.root),
        });
      });
    });
  }

  /** Kill anything this sandbox left running (detached previews included). */
  dispose() {
    for (const c of this.children) {
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
}

export const Sandbox = {
  async create() {
    const name = `local-${Math.random().toString(36).slice(2, 10)}`;
    const sandbox = new LocalSandbox(name);
    registry.set(name, sandbox);
    return sandbox;
  },
  async get({ name }) {
    const sandbox = registry.get(name);
    if (!sandbox) throw new Error(`No local sandbox named ${name}`);
    return sandbox;
  },
};

export function allSandboxes() {
  return [...registry.values()];
}
