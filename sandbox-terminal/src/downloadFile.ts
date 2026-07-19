/**
 * Browser helpers so the user can actually keep generated files.
 */

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || 'file.txt';
}

function mimeForPath(path: string): string {
  const ext = basename(path).split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'text/typescript', tsx: 'text/typescript',
    js: 'text/javascript', jsx: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
    json: 'application/json', md: 'text/markdown',
    css: 'text/css', html: 'text/html', htm: 'text/html',
    py: 'text/x-python', go: 'text/x-go', rs: 'text/x-rust',
    yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/plain',
    sh: 'text/x-shellscript', txt: 'text/plain',
  };
  return map[ext] ?? 'text/plain';
}

/** Download one complete file with its real filename. */
export function downloadTextFile(path: string, content: string): void {
  const name = basename(path);
  const blob = new Blob([content], { type: `${mimeForPath(path)};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

/** Download every file (staggered so mobile browsers don't block). */
export async function downloadAllFiles(
  files: Array<{ path: string; content: string }>,
): Promise<void> {
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    downloadTextFile(f.path, f.content);
    if (i < files.length - 1) {
      await new Promise(r => setTimeout(r, 250));
    }
  }
}

/** Copy full file text — useful when download is blocked on mobile. */
export async function copyText(content: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = content;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
