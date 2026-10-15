/**
 * Preview + smoke-test detection for stacks the coder may pick beyond Node and
 * plain HTML — a Flask/FastAPI app, a Python script server, a bare Express file.
 * Without this, Preview fell through to `python3 -m http.server` (a directory
 * listing of the source) and Auto-test found nothing to run, so Push stayed locked.
 */

/** Syntax-checks every .py file; fails on the first broken one. Single shell line. */
export const PYTHON_SMOKE_COMMAND =
  "python3 -m compileall -q -x '(node_modules|venv|[.]git)' . && echo 'python smoke ok: all files compile'";

/** Syntax-checks the Node entry file. Single shell line. */
export const NODE_ENTRY_SMOKE_COMMAND =
  'for f in server.js app.js index.js main.js; do if [ -f "$f" ]; then node --check "$f" && echo "node smoke ok: $f parses" && exit 0; exit 1; fi; done; exit 1';

/**
 * Shell lines that set RUN_CMD for Preview when no command was typed.
 * Runs with the project directory as cwd. Order: npm dev → npm start → Python
 * app → Node entry file → plain static server.
 */
export function previewResolveLines(port) {
  const p = Number(port);
  return [
    'PY=python3; [ -x /vercel/sandbox/venv/bin/python ] && PY=/vercel/sandbox/venv/bin/python',
    `if [ -f package.json ] && node -e "process.exit((require('./package.json').scripts||{}).dev?0:1)" >/dev/null 2>&1; then`,
    `  RUN_CMD="npm run dev"`,
    `elif [ -f package.json ] && node -e "process.exit((require('./package.json').scripts||{}).start?0:1)" >/dev/null 2>&1; then`,
    `  RUN_CMD="npm start"`,
    `elif [ -f app.py ] || [ -f main.py ] || [ -f server.py ]; then`,
    `  ENTRY=app.py; [ -f "$ENTRY" ] || ENTRY=main.py; [ -f "$ENTRY" ] || ENTRY=server.py`,
    `  MOD="\${ENTRY%.py}"`,
    `  if grep -q "FastAPI(" "$ENTRY"; then RUN_CMD="$PY -m uvicorn $MOD:app --host 0.0.0.0 --port ${p}"`,
    `  elif grep -q "Flask(" "$ENTRY"; then RUN_CMD="$PY -m flask --app $MOD run --host 0.0.0.0 --port ${p}"`,
    `  else RUN_CMD="PORT=${p} $PY $ENTRY"; fi`,
    `elif [ ! -f index.html ] && { [ -f server.js ] || [ -f app.js ] || [ -f index.js ]; }; then`,
    `  ENTRY=server.js; [ -f "$ENTRY" ] || ENTRY=app.js; [ -f "$ENTRY" ] || ENTRY=index.js`,
    `  RUN_CMD="PORT=${p} node $ENTRY"`,
    `elif command -v python3 >/dev/null 2>&1; then`,
    `  RUN_CMD="python3 -m http.server ${p}"`,
    `else`,
    `  RUN_CMD="npx --yes serve -l ${p} ."`,
    `fi`,
  ];
}

/** Installs Python deps before the preview starts, when the project lists any. */
export function pythonInstallLines(logFile) {
  return [
    'PY=python3; [ -x /vercel/sandbox/venv/bin/python ] && PY=/vercel/sandbox/venv/bin/python',
    `if [ -f requirements.txt ]; then "$PY" -m pip install -q -r requirements.txt >> ${logFile} 2>&1 || echo "pip install had errors — see preview log"; fi`,
  ];
}
