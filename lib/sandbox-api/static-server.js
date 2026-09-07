/**
 * A tiny static file server dropped into the sandbox so a plain HTML/CSS/JS
 * project can be previewed.
 *
 * Workspace's most common output is a static site — detect-test-command
 * already treats "no package.json, but there is an index.html" as a
 * first-class project shape. Preview used to hardcode `npm run dev`, which
 * cannot start such a project at all, so the preview pane stayed empty and
 * the app looked broken even though the files were on disk.
 *
 * Written to disk as a file (not inlined into the command) so the command
 * shown in the UI stays short and editable.
 */

export const STATIC_SERVER_PATH = '/tmp/.workspace-static-server.mjs';

export function staticServeCommand(dir, port) {
  return `node ${STATIC_SERVER_PATH} ${JSON.stringify(dir)} ${port}`;
}

export const STATIC_SERVER_SOURCE = `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || process.cwd());
const port = Number(process.argv[3] || 3000);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.txt':  'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map':  'application/json; charset=utf-8',
};

function resolveTarget(urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const abs = path.resolve(root, '.' + rel);
  // Never serve outside the project directory.
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    const idx = path.join(abs, 'index.html');
    return fs.existsSync(idx) ? idx : null;
  }
  if (fs.existsSync(abs)) return abs;
  // SPA-style fallback: extension-less routes fall back to the entry page.
  if (!path.extname(abs)) {
    const idx = path.join(root, 'index.html');
    if (fs.existsSync(idx)) return idx;
  }
  return null;
}

http
  .createServer((req, res) => {
    const target = resolveTarget(req.url || '/');
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const type = TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(target).pipe(res);
  })
  .listen(port, '0.0.0.0', () => {
    console.log('static server listening on ' + port + ' serving ' + root);
  });
`;
