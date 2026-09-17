"""
Lip-sync an existing clip to a voice track — the `lip-sync` app.

Serves POST https://ic4pi--lip-sync-run.modal.run, consumed by
?op=lipsync in api/media-generate.js.

    request   {video, audio, face?, face_point?}
    response  {video_base64, face_count, face_used, elapsed_seconds}

`video` / `audio` / `face` are https URLs or data: URLs. Bytes never have to
cross Vercel when storage is configured — same contract as video-stitch.

This is a post-pass on ANY finished clip (Wan, LTX, an upload). It is not
tied to Wan. It rewrites the mouth of one chosen face and leaves the rest of
the frame alone, so last-frame-flow scenes stay intact.

Which face talks, when there are several:
  1. `face` — a still of the character. InsightFace embeddings pick the match.
  2. `face_point` — {x, y} in 0–1, a click on the frame. Nearest/containing box.
  3. Otherwise the largest face that clears the size floor.

Faces smaller than ~8% of the frame are skipped. At that size you would not
see the mouth moving anyway, and the model cannot track it.

Model: ByteDance LatentSync 1.5 (Apache-2.0). Wav2Lip is not used — its
weights were trained on LRS2/LRS3 (BBC), which are research-only.

Deploy as a NEW app, never over wan/ltx:
    modal deploy modal/lipsync_app.py
"""

import base64
import os
import subprocess
import tempfile
import time

import fastapi
import modal

MAX_SECONDS = 45
MIN_FACE_FRAC = 0.08  # skip faces you could not read the lips on anyway
SHARED_SECRET = os.environ.get("MODAL_SHARED_SECRET", "")
REPO = "/opt/latentsync"
CKPT_DIR = "/cache/latentsync"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "libgl1", "libglib2.0-0")
    .pip_install(
        "torch==2.6.0",
        "torchvision==0.21.0",
        "torchaudio==2.6.0",
        extra_index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install(
        "diffusers==0.32.2",
        "transformers==4.47.1",
        "accelerate==1.2.1",
        "omegaconf",
        "einops",
        "opencv-python-headless",
        "insightface",
        "onnxruntime-gpu",
        "huggingface_hub",
        "soundfile",
        "librosa",
        "pillow",
        "numpy",
        "fastapi[standard]",
        "requests",
    )
    .run_commands(
        "git clone --depth 1 https://github.com/bytedance/LatentSync.git /opt/latentsync"
    )
)

app = modal.App(os.environ.get("MODAL_APP_NAME", "lip-sync"))
cache = modal.Volume.from_name("latentsync-cache", create_if_missing=True)


def _check_secret(x_modal_secret: str) -> None:
    if SHARED_SECRET and x_modal_secret != SHARED_SECRET:
        raise fastapi.HTTPException(status_code=401, detail="Invalid or missing X-Modal-Secret header.")


def _fetch(src: str, path: str) -> None:
    if not src:
        raise ValueError("empty media")
    if src.startswith("http://") or src.startswith("https://"):
        import requests

        resp = requests.get(src, timeout=180)
        resp.raise_for_status()
        with open(path, "wb") as fh:
            fh.write(resp.content)
        return
    if src.startswith("data:"):
        src = src.split(",", 1)[-1]
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(src))


def _decode_image(data: str):
    from PIL import Image
    import io

    if not data:
        return None
    raw = data
    if data.startswith("data:"):
        raw = data.split(",", 1)[-1]
    return Image.open(io.BytesIO(base64.b64decode(raw))).convert("RGB")


def _first_frame(video_path: str):
    import cv2
    from PIL import Image

    cap = cv2.VideoCapture(video_path)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise ValueError("Could not read a frame from the clip.")
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    return Image.fromarray(rgb), rgb.shape[1], rgb.shape[0]


def _area_frac(bbox, width, height):
    x1, y1, x2, y2 = bbox
    return max(0, (x2 - x1) * (y2 - y1)) / float(width * height or 1)


def _pick_face(faces, width, height, face_point=None, face_emb=None):
    import numpy as np

    usable = []
    for f in faces:
        bbox = [float(x) for x in f.bbox]
        if _area_frac(bbox, width, height) < MIN_FACE_FRAC:
            continue
        usable.append(f)
    if not usable:
        return None, "too_small", len(faces)

    if face_emb is not None:
        def sim(f):
            a = np.asarray(f.normed_embedding if hasattr(f, "normed_embedding") else f.embedding, dtype=np.float32)
            b = np.asarray(face_emb, dtype=np.float32)
            return float(a @ b) / (float(np.linalg.norm(a) * np.linalg.norm(b)) or 1)

        return max(usable, key=sim), "reference", len(faces)

    if face_point and isinstance(face_point, dict):
        px = float(face_point.get("x", 0.5)) * width
        py = float(face_point.get("y", 0.5)) * height

        def score(f):
            x1, y1, x2, y2 = [float(v) for v in f.bbox]
            if x1 <= px <= x2 and y1 <= py <= y2:
                return (0, -((x2 - x1) * (y2 - y1)))
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
            return (1, (cx - px) ** 2 + (cy - py) ** 2)

        return min(usable, key=score), "click", len(faces)

    return max(usable, key=lambda f: _area_frac(f.bbox, width, height)), "largest", len(faces)


def _padded_box(bbox, width, height, pad=0.35):
    x1, y1, x2, y2 = [float(v) for v in bbox]
    bw, bh = x2 - x1, y2 - y1
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    side = max(bw, bh) * (1 + pad)
    # even pixel sizes for ffmpeg crop
    w = int(max(64, min(width, side))) // 2 * 2
    h = int(max(64, min(height, side))) // 2 * 2
    x = int(max(0, min(width - w, cx - w / 2))) // 2 * 2
    y = int(max(0, min(height - h, cy - h / 2))) // 2 * 2
    return x, y, w, h


@app.cls(
    gpu="A10G",
    image=image,
    volumes={"/cache": cache},
    scaledown_window=300,
    timeout=1800,
)
class LipSync:
    @modal.enter()
    def load(self):
        import insightface
        from huggingface_hub import snapshot_download

        os.environ["HF_HOME"] = "/cache/hf"
        os.makedirs(CKPT_DIR, exist_ok=True)
        # 1.5 fits an A10G with room; 1.6 wants ~18GB and is an env bump.
        snapshot_download(
            os.environ.get("LATENTSYNC_REPO_ID", "ByteDance/LatentSync-1.5"),
            local_dir=CKPT_DIR,
        )
        self.face = insightface.app.FaceAnalysis(name="buffalo_l", root="/cache/insightface")
        self.face.prepare(ctx_id=0, det_size=(640, 640))
        self.ready = True

    @modal.method()
    def ping(self) -> dict:
        return {"ready": True}

    @modal.method()
    def run(self, video: str, audio: str, face: str = "", face_point=None) -> dict:
        started = time.time()
        with tempfile.TemporaryDirectory() as tmp:
            vid_in = os.path.join(tmp, "in.mp4")
            aud_in = os.path.join(tmp, "in.audio")
            _fetch(video, vid_in)
            _fetch(audio, aud_in)

            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", vid_in],
                check=True, capture_output=True, text=True, timeout=60,
            ).stdout.strip()
            dur = float(probe or 0)
            if dur > MAX_SECONDS:
                raise ValueError(f"Clip is {dur:.0f}s; lip-sync ceiling is {MAX_SECONDS}s.")

            frame, width, height = _first_frame(vid_in)
            import numpy as np

            det = self.face.get(np.array(frame)[:, :, ::-1])  # BGR
            face_emb = None
            ref = _decode_image(face) if face else None
            if ref is not None:
                ref_faces = self.face.get(np.array(ref)[:, :, ::-1])
                if ref_faces:
                    f0 = ref_faces[0]
                    face_emb = f0.normed_embedding if hasattr(f0, "normed_embedding") else f0.embedding

            chosen, how, n_faces = _pick_face(det, width, height, face_point, face_emb)
            if chosen is None:
                raise ValueError(
                    "No face large enough to lip-sync. "
                    "At that distance you would not see the mouth moving anyway — use a closer beat."
                )

            x, y, w, h = _padded_box(chosen.bbox, width, height)
            crop = os.path.join(tmp, "face.mp4")
            subprocess.run(
                ["ffmpeg", "-y", "-i", vid_in, "-vf", f"crop={w}:{h}:{x}:{y}",
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", crop],
                check=True, capture_output=True, timeout=300,
            )

            synced = os.path.join(tmp, "synced.mp4")
            ckpt = os.path.join(CKPT_DIR, "latentsync_unet.pt")
            if not os.path.exists(ckpt):
                # HF layout varies by version; take the first *.pt that isn't whisper.
                pts = []
                for root, _, files in os.walk(CKPT_DIR):
                    for name in files:
                        if name.endswith(".pt") and "whisper" not in name.lower():
                            pts.append(os.path.join(root, name))
                if not pts:
                    raise RuntimeError("LatentSync checkpoint missing after download.")
                ckpt = pts[0]

            cfg = os.path.join(REPO, "configs", "unet.yaml")
            if not os.path.exists(cfg):
                for cand in (
                    os.path.join(REPO, "configs", "unet", "stage2.yaml"),
                    os.path.join(REPO, "configs", "syncnet", "syncnet.yaml"),
                ):
                    if os.path.exists(cand):
                        cfg = cand
                        break

            env = os.environ.copy()
            env["PYTHONPATH"] = REPO + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
            inf = subprocess.run(
                [
                    "python", "-m", "scripts.inference",
                    "--unet_config_path", cfg,
                    "--inference_ckpt_path", ckpt,
                    "--video_path", crop,
                    "--audio_path", aud_in,
                    "--video_out_path", synced,
                    "--inference_steps", "20",
                    "--temp_dir", os.path.join(tmp, "ls"),
                ],
                cwd=REPO,
                env=env,
                capture_output=True,
                text=True,
                timeout=1500,
            )
            if inf.returncode != 0 or not os.path.exists(synced):
                tail = (inf.stderr or inf.stdout or "")[-1800:]
                raise RuntimeError(f"LatentSync failed: {tail}")

            out_path = os.path.join(tmp, "out.mp4")
            # Paste the lip-synced crop back onto the original full frame.
            # Audio comes from the synced file (the supplied voice).
            overlay = (
                f"[1:v]scale={w}:{h}[c];"
                f"[0:v][c]overlay={x}:{y}:shortest=1[v]"
            )
            mux = subprocess.run(
                ["ffmpeg", "-y", "-i", vid_in, "-i", synced,
                 "-filter_complex", overlay,
                 "-map", "[v]", "-map", "1:a:0?",
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
                 "-c:a", "aac", "-b:a", "192k", "-shortest",
                 "-movflags", "+faststart", out_path],
                capture_output=True, timeout=300,
            )
            if mux.returncode != 0 or not os.path.exists(out_path):
                # Crop-only is still a usable result if overlay fails.
                out_path = synced

            with open(out_path, "rb") as fh:
                video_b64 = base64.b64encode(fh.read()).decode()

        return {
            "video_base64": video_b64,
            "elapsed_seconds": round(time.time() - started, 2),
            "face_count": n_faces,
            "face_used": how,
            "bbox": {"x": x, "y": y, "w": w, "h": h},
        }


@app.function(image=image, timeout=1800)
@modal.fastapi_endpoint(method="POST")
def run(
    payload: dict,
    x_modal_secret: str = fastapi.Header(default="", alias="X-Modal-Secret"),
) -> dict:
    _check_secret(x_modal_secret)
    video = (payload.get("video") or "").strip()
    audio = (payload.get("audio") or "").strip()
    if not video or not audio:
        return {"error": "video and audio are required."}
    try:
        return LipSync().run.remote(
            video=video,
            audio=audio,
            face=payload.get("face") or "",
            face_point=payload.get("face_point") or payload.get("facePoint"),
        )
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


@app.function(image=image, timeout=60)
@modal.fastapi_endpoint(method="POST")
def warm(
    x_modal_secret: str = fastapi.Header(default="", alias="X-Modal-Secret"),
) -> dict:
    _check_secret(x_modal_secret)
    try:
        LipSync().ping.spawn()
        return {"warming": True}
    except Exception as exc:
        return {"warming": False, "error": f"{type(exc).__name__}: {exc}"}
