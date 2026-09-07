#!/usr/bin/env python3
"""
Generate a real image on the just-deployed Modal app and fail if it does not
come back.

  python3 .github/scripts/modal_smoke.py --workspace ic4pi --suffix -v2

"deployed successfully" only means the container image built. It says nothing
about whether the checkpoint loads on a GPU or whether a request returns
pixels - which is exactly the gap that let a dead checkpoint id sit in this
repo while deploys went green. This closes it: one small image, actually
generated, and the endpoints for the two video apps confirmed to exist.

The image request pays a cold start (the container has to boot an L4 and load
the checkpoint), hence the long timeout.
"""

import argparse
import json
import sys
import urllib.error
import urllib.request

GENERATE_TIMEOUT = 900
PING_TIMEOUT = 60


def post(url, payload, timeout):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        return e.code, {"error": detail}
    except Exception as e:
        return 0, {"error": f"{type(e).__name__}: {e}"}


def endpoint(workspace, app, fn):
    return f"https://{workspace}--{app}-{fn}.modal.run"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", required=True)
    ap.add_argument("--suffix", default="")
    ap.add_argument("--apps", default="all")
    args = ap.parse_args()

    failures = []
    want = args.apps

    if want in ("all", "sdxl"):
        url = endpoint(args.workspace, f"sdxl-nsfw{args.suffix}", "generate")
        print(f"generating a test image on {url} (cold start, be patient)...", flush=True)
        # Small and few steps: this proves the checkpoint loads and the
        # pipeline runs, and nothing more is needed for that.
        status, body = post(
            url,
            {"prompt": "a red apple on a wooden table", "width": 512, "height": 512,
             "steps": 8, "n": 1, "model": "lustify"},
            GENERATE_TIMEOUT,
        )
        images = body.get("images_base64") or ([body["image_base64"]] if body.get("image_base64") else [])
        if status == 200 and images:
            print(f"  OK - {len(images)} image, {len(images[0])} base64 chars, "
                  f"{body.get('elapsed_seconds', '?')}s")
        else:
            msg = body.get("error") or f"HTTP {status} with no image in the response"
            print(f"  FAILED - {msg}")
            failures.append(f"sdxl generate: {msg}")

    # Video generation is minutes of GPU per clip; confirming the endpoints
    # exist is the proportionate check here. A 404 means the app is not
    # deployed under that name, which is the failure worth catching.
    for name, app in (("wan", f"wan-video{args.suffix}"), ("ltx", f"ltx-video{args.suffix}")):
        if want not in ("all", name):
            continue
        url = endpoint(args.workspace, app, "warm")
        status, body = post(url, {}, PING_TIMEOUT)
        if status == 404:
            print(f"{name} warm: FAILED - 404, no app deployed at {url}")
            failures.append(f"{name}: not deployed at {url}")
        elif status == 0:
            print(f"{name} warm: FAILED - {body.get('error')}")
            failures.append(f"{name}: {body.get('error')}")
        else:
            print(f"{name} warm: OK - HTTP {status} {json.dumps(body)[:120]}")

    print()
    if failures:
        print("SMOKE FAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("SMOKE OK - the deployed apps answer and SDXL returns a real image.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
