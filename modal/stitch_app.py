"""
Join generated clips into one video — the `video-stitch` app.

Serves POST https://ic4pi--video-stitch-join.modal.run, consumed by the
?op=stitch route in api/media-generate.js.

    request   {clips: [url | data-url | bare base64, ...], fps?, width?, height?}
    response  {video_base64, count, elapsed_seconds, width, height, fps}

CPU only, deliberately. Concatenation is an ffmpeg job, not a model job, and
ffmpeg is already in the video apps' images — putting this on a GPU would bill
A100 time for something a CPU does in seconds. It is a separate app rather
than another endpoint on wan/ltx so that joining clips never wakes a
weights-loading GPU container.

Deploy:  modal deploy modal/stitch_app.py
"""

import base64
import os
import subprocess
import tempfile
import time

import modal

MAX_CLIPS = 24
# Vercel caps a response body at 4.5MB, but this app answers the API, not the
# browser — the API stores the result and returns a URL. The ceiling that
# matters here is the request Modal will accept.
MAX_TOTAL_BYTES = 200 * 1024 * 1024

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("fastapi[standard]", "requests")
)

app = modal.App(os.environ.get("MODAL_APP_NAME", "video-stitch"))

SHARED_SECRET = os.environ.get("MODAL_SHARED_SECRET", "")


def _check_secret(request) -> None:
    """Same optional gate as the video apps: unset here means open."""
    if not SHARED_SECRET:
        return
    import fastapi

    if request.headers.get("X-Modal-Secret") != SHARED_SECRET:
        raise fastapi.HTTPException(status_code=401, detail="Bad or missing X-Modal-Secret.")


def _fetch(clip: str, path: str) -> None:
    """Write one clip to disk, whether it arrived as a URL or as bytes."""
    if clip.startswith("http://") or clip.startswith("https://"):
        import requests

        resp = requests.get(clip, timeout=120)
        resp.raise_for_status()
        with open(path, "wb") as fh:
            fh.write(resp.content)
        return

    if clip.startswith("data:"):
        clip = clip.split(",", 1)[-1]
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(clip))


def _probe(path: str) -> tuple[int, int, float]:
    """Dimensions and frame rate of a clip, via ffprobe."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        check=True, capture_output=True, text=True, timeout=60,
    ).stdout.split()
    num, _, den = out[2].partition("/")
    return int(out[0]), int(out[1]), (float(num) / float(den or 1))


@app.function(image=image, timeout=1800, cpu=2.0, memory=4096)
@modal.fastapi_endpoint(method="POST")
def join(payload: dict, request=None) -> dict:
    if request is not None:
        _check_secret(request)

    clips = payload.get("clips") or []
    if not isinstance(clips, list) or len(clips) < 2:
        return {"error": "Send at least two clips."}
    if len(clips) > MAX_CLIPS:
        return {"error": f"Too many clips ({len(clips)}); the ceiling is {MAX_CLIPS}."}

    started = time.time()
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        try:
            for i, clip in enumerate(clips):
                path = os.path.join(tmp, f"in{i:03d}.mp4")
                _fetch(str(clip), path)
                paths.append(path)
        except Exception as exc:
            return {"error": f"Could not read clip {len(paths)}: {type(exc).__name__}: {exc}"}

        total = sum(os.path.getsize(p) for p in paths)
        if total > MAX_TOTAL_BYTES:
            return {"error": f"Clips total {total / 1048576:.0f}MB, over the {MAX_TOTAL_BYTES // 1048576}MB ceiling."}

        try:
            probed = [_probe(p) for p in paths]
        except Exception as exc:
            return {"error": f"ffprobe failed: {type(exc).__name__}: {exc}"}

        # The concat filter refuses inputs that disagree on size or pixel
        # aspect, and clips here genuinely do disagree: the apps run at
        # different native geometry, and the post-process pass doubles frame
        # rate only when it succeeds. Normalising every input to one geometry
        # first is what makes a mixed batch joinable at all. The first clip
        # sets the target, since it is the one the caller saw first; the
        # highest rate present is kept so a smoothed clip is not thrown back
        # down to 16fps.
        width = int(payload.get("width") or probed[0][0])
        height = int(payload.get("height") or probed[0][1])
        fps = float(payload.get("fps") or max(p[2] for p in probed))

        parts, labels = [], ""
        for i in range(len(paths)):
            parts.append(
                f"[{i}:v]scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}[v{i}]"
            )
            labels += f"[v{i}]"
        graph = ";".join(parts) + f";{labels}concat=n={len(paths)}:v=1:a=0[out]"

        out_path = os.path.join(tmp, "joined.mp4")
        cmd = ["ffmpeg", "-y"]
        for p in paths:
            cmd += ["-i", p]
        cmd += ["-filter_complex", graph, "-map", "[out]",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
                "-movflags", "+faststart", out_path]

        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=1500)
        except subprocess.CalledProcessError as exc:
            # ffmpeg puts the actual reason on stderr; without it the caller
            # only learns that a subprocess exited non-zero.
            tail = (exc.stderr or b"").decode("utf-8", "replace").strip()[-1500:]
            return {"error": f"ffmpeg failed: {tail}"}
        except Exception as exc:
            return {"error": f"{type(exc).__name__}: {exc}"}

        with open(out_path, "rb") as fh:
            video_b64 = base64.b64encode(fh.read()).decode()

    return {
        "video_base64": video_b64,
        "count": len(paths),
        "width": width,
        "height": height,
        "fps": fps,
        "elapsed_seconds": round(time.time() - started, 2),
    }
