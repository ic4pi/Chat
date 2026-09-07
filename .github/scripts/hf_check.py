#!/usr/bin/env python3
"""
Ask Hugging Face whether the model repos the Modal apps pull are reachable.

  python3 .github/scripts/hf_check.py --status <repo-id>...
  python3 .github/scripts/hf_check.py --search "lustify sdxl"

A repo that has been deleted, renamed or gated fails the Modal image build
about ten minutes in, as a RepositoryNotFoundError buried in build output —
which is how a dead SDXL checkpoint read as a caching bug for days. This
answers it in seconds, before anything is built.

Exit code 1 if any repo is unreachable, so the workflow can stop early.
Reads HF_TOKEN from the environment when a repo is gated.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "https://huggingface.co/api/models"


def _get(url):
    req = urllib.request.Request(url)
    token = os.environ.get("HF_TOKEN", "").strip()
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:  # DNS, TLS, timeout
        print(f"    request failed: {e}", file=sys.stderr)
        return 0, None


def describe(meta):
    files = [s.get("rfilename", "") for s in meta.get("siblings", [])]
    return (
        ("GATED" if meta.get("gated") else "public")
        + f" | fp16 variant: {'yes' if any('fp16' in f for f in files) else 'no'}"
        + f" | safetensors: {sum(1 for f in files if f.endswith('.safetensors'))}"
        + f" | downloads: {meta.get('downloads', 0)}"
    )


def status(repo_ids):
    bad = []
    lines = []
    for repo in repo_ids:
        code, meta = _get(f"{API}/{repo}")
        if code == 200:
            note = describe(meta)
        elif code in (401, 403):
            note = "NOT ACCESSIBLE — gated or private, needs an HF_TOKEN secret"
            bad.append(repo)
        elif code == 404:
            note = "DOES NOT EXIST — the repo id is wrong or it was removed"
            bad.append(repo)
        else:
            note = f"HTTP {code}"
            bad.append(repo)
        line = f"{code:>3}  {repo}  —  {note}"
        print(line)
        lines.append(f"- `{repo}` — {code} — {note}")
    summarise("Model repos", lines)
    return bad


def search(terms):
    for term in terms:
        term = term.strip()
        if not term:
            continue
        print(f"=== {term} ===")
        query = urllib.parse.urlencode(
            {"search": term, "limit": 40, "sort": "downloads", "direction": -1}
        )
        code, rows = _get(f"{API}?{query}")
        if code != 200 or not rows:
            print("    (no matches)")
            summarise(term, ["- (no matches)"])
            continue
        lines = []
        for m in rows:
            mark = "GATED" if m.get("gated") else "     "
            line = f"{m.get('downloads', 0):>9}  {mark}  {m['id']}"
            print(line)
            lines.append(f"- `{m['id']}` — {m.get('downloads', 0)} downloads"
                         + (" — GATED" if m.get("gated") else ""))
        summarise(term, lines)


def summarise(heading, lines):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    with open(path, "a") as fh:
        fh.write(f"\n### {heading}\n" + "\n".join(lines) + "\n")


def files(repo_ids):
    """List a repo's files. Which weight file to load is not guessable: the
    Lightning LoRA repo carries one set per Wan variant, and the wrong one
    fails with hundreds of shape mismatches rather than a name error."""
    for repo in repo_ids:
        code, meta = _get(f"{API}/{repo}")
        if code != 200:
            print(f"{repo}: HTTP {code}")
            continue
        names = [s.get("rfilename", "") for s in meta.get("siblings", [])]
        print(f"=== {repo} ({len(names)} files) ===")
        lines = []
        for n in sorted(names):
            if n.endswith((".safetensors", ".ckpt", ".pt", ".bin")):
                print(f"  {n}")
                lines.append(f"- `{n}`")
        summarise(f"files in {repo}", lines or ["- (no weight files)"])


def main(argv):
    if len(argv) < 2:
        sys.exit("usage: hf_check.py --status <repo>... | --search <term>...")
    mode, rest = argv[1], argv[2:]
    if mode == "--status":
        ids = rest or [ln.strip() for ln in sys.stdin if ln.strip()]
        bad = status(ids)
        if bad:
            print(f"\nUnreachable: {', '.join(bad)}", file=sys.stderr)
            return 1
        return 0
    if mode == "--search":
        search(rest)
        return 0
    if mode == "--files":
        files(rest)
        return 0
    sys.exit(f"unknown mode {mode}")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
