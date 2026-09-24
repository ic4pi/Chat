"""
Wan 2.2 I2V-A14B on Modal — the `wan-video-a14b-i2v` app.

Why this exists: wan_a14b_app.py (T2V-A14B) is the only Wan variant with a
working NSFW LoRA, but it has no image input at all — text only. wan_app.py
(TI2V-5B) is the only Wan variant that takes an image, but it is the stock
Wan-AI checkpoint with content alignment trained in and no NSFW LoRA built
for its architecture (nothing on Hugging Face targets TI2V-5B's shape).
Concretely: hand it an explicit source photo and the alignment training
overrides it — output comes back with clothes added in a tame setting,
same behavior already documented for T2V prompts in wan_a14b_app.py, now
confirmed for image conditioning too. There has been no combination in this
stack of (takes an image) and (not aligned back to "safe").

This is that combination: Wan2.2-I2V-A14B-Diffusers, the real I2V-specific
14B checkpoint, with the NSFW LoRA that wan_a14b_app.py's own comment
already identified as trained for exactly this architecture:

    "First attempt (lopi999/Wan2.2-I2V_General-NSFW-LoRA) loaded without
    error but didn't visibly change output — trained against I2V-A14B, not
    T2V" (wan_a14b_app.py, NSFW_LORA_REPO comment)

That LoRA was stacked onto the wrong model there. This is the right one.

Cannot share a container with either existing A14B app: T2V-A14B's two 14B
experts are already ~56GB in bf16, and I2V-A14B is a separate 14B-parameter
pair, not a mode switch on the same weights — holding both would need
~110GB+ of VRAM for transformers alone. Needs its own A100-80GB, same as
wan_a14b_app.py.

!! UNVERIFIED — written from the architecture and the LoRA repo name alone,
not run on a GPU. Two things are genuine guesses and need confirming against
the real repos before trusting this in production:
  1. The NSFW LoRA's actual weight file names — discovered at load time via
     list_repo_files() rather than hardcoded, specifically because guessing
     wrong here is the exact failure this file exists to avoid repeating.
  2. Whether lightx2v/Wan2.2-Lightning ships an I2V-A14B subfolder at all —
     wrapped in the same try/except-and-fall-back-to-full-steps pattern
     wan_a14b_app.py already uses, so a wrong guess costs speed, not
     correctness.

Deploy:  modal deploy modal/wan_a14b_i2v_app.py
Then before spending a real generation on it, hit the free diagnostic:
  curl -X POST https://<user>--wan-video-a14b-i2v-status.modal.run
and check nsfw_available is true. If it's false, nsfw_lora_error names why
(wrong file names is the likely one — it will also list what the repo
actually contains).
"""

import base64
import io
import os
import random
import time

import modal

MODEL_ID = os.environ.get("WAN_A14B_I2V_MODEL_ID", "Wan-AI/Wan2.2-I2V-A14B-Diffusers")

# Guessed by analogy to WAN_A14B_LIGHTNING_LORA_SUBFOLDER in wan_a14b_app.py
# ("Wan2.2-T2V-A14B-4steps-lora-250928") — unverified whether this subfolder
# exists. Failure here is caught and falls back to full steps; see load().
LIGHTNING_LORA_REPO = os.environ.get("WAN_A14B_I2V_LIGHTNING_LORA_REPO", "lightx2v/Wan2.2-Lightning")
LIGHTNING_LORA_SUBFOLDER = os.environ.get(
    "WAN_A14B_I2V_LIGHTNING_LORA_SUBFOLDER", "Wan2.2-I2V-A14B-4steps-lora-250928"
)

# The LoRA wan_a14b_app.py's own comment names as trained for this exact
# architecture, previously stacked onto the wrong model (T2V-A14B) by mistake.
NSFW_LORA_REPO = os.environ.get("WAN_A14B_I2V_NSFW_LORA_REPO", "lopi999/Wan2.2-I2V_General-NSFW-LoRA")
# Explicit override escape hatch — set both to skip discovery entirely if the
# real file names turn out to differ from what auto-discovery picks.
NSFW_LORA_HIGH_FILE = os.environ.get("WAN_A14B_I2V_NSFW_LORA_HIGH_FILE", "")
NSFW_LORA_LOW_FILE = os.environ.get("WAN_A14B_I2V_NSFW_LORA_LOW_FILE", "")
NSFW_LORA_TRIGGER = os.environ.get("WAN_A14B_I2V_NSFW_LORA_TRIGGER", "")

FAST_STEPS = 4
FAST_GUIDANCE = 1.0
FULL_STEPS = 40
FULL_GUIDANCE = 4.0

DEFAULT_FPS = 16
FRAMES_PER_CLIP = 81  # ~5s at 16fps, matching the other A14B app's convention
MAX_FRAMES = 321  # 4*80+1, ~20s at 16fps — no chaining, same reasoning as T2V-A14B

# No MODAL_SHARED_SECRET check here, matching wan_a14b_app.py (its sibling
# app) — that gate exists on wan_app.py only; carrying it here without it
# also being enforced on the sibling would be an inconsistency, not a fix.


def _decode_image(data: str):
    from PIL import Image

    if not data:
        return None
    if data.startswith("data:"):
        data = data.split(",", 1)[-1]
    return Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB")


def _find_lora_files(repo_id: str):
    """Pick the high/low-noise-expert weight files out of a LoRA repo by
    name pattern instead of a hardcoded guess. Wrong hardcoded names is
    exactly the failure this app exists to not repeat (see module docstring)
    — a repo whose actual names don't match "high"/"low" at all still
    surfaces every .safetensors file it has, so nsfw_lora_error is
    something a human can act on rather than a bare KeyError.
    """
    from huggingface_hub import list_repo_files

    files = [f for f in list_repo_files(repo_id) if f.endswith(".safetensors")]
    high = next((f for f in files if "high" in f.lower()), None)
    low = next((f for f in files if "low" in f.lower()), None)
    if not (high and low) and len(files) == 2:
        # Two files, no naming pattern hit — assume the paired order the repo
        # lists them in rather than fail on a config that doesn't add explicit
        # high/low markers to the filenames.
        high, low = files[0], files[1]
    return high, low, files


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "av",
        "torch==2.6.0",
        "diffusers==0.36.0",
        "transformers==4.51.3",
        "accelerate==1.6.0",
        "peft==0.17.1",
        "huggingface_hub",
        "safetensors",
        "sentencepiece",
        "ftfy",
        "imageio",
        "imageio-ffmpeg",
        "pillow",
        "fastapi[standard]",
    )
)

app = modal.App(os.environ.get("MODAL_APP_NAME", "wan-video-a14b-i2v"))
cache = modal.Volume.from_name("wan-a14b-i2v-model-cache", create_if_missing=True)


def _export_polished(frames, path: str, fps: int, upscale: int = 2) -> int:
    """Same post pass as wan_a14b_app.py — see that file for the rationale."""
    from diffusers.utils import export_to_video

    raw_path = path + ".raw.mp4"
    export_to_video(frames, raw_path, fps=fps)
    out_fps = fps * 2
    vf = (
        f"scale=iw*{upscale}:ih*{upscale}:flags=lanczos,"
        f"minterpolate=fps={out_fps}:mi_mode=blend"
    )
    try:
        import subprocess

        subprocess.run(
            ["ffmpeg", "-y", "-i", raw_path, "-vf", vf,
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", path],
            check=True, capture_output=True, timeout=300,
        )
        os.remove(raw_path)
        return out_fps
    except Exception as exc:
        print(f"post-process pass failed, shipping raw clip: {exc!r}", flush=True)
        os.replace(raw_path, path)
        return fps


@app.cls(
    gpu="A100-80GB",
    image=image,
    volumes={"/cache": cache},
    scaledown_window=300,
    timeout=3600,
)
class WanA14BI2V:
    @modal.enter()
    def load(self):
        import torch
        from diffusers import WanImageToVideoPipeline

        os.environ["HF_HOME"] = "/cache/hf"

        # from_pretrained, not the class directly — the same reason
        # wan_app.py insists on it for TI2V-5B: only from_pretrained reads
        # model_index.json to pick the correct conditioning path for this
        # specific checkpoint's architecture.
        self.pipe = WanImageToVideoPipeline.from_pretrained(
            MODEL_ID, torch_dtype=torch.bfloat16, cache_dir="/cache/hf"
        )

        self.fast = False
        self.lora_error = None if LIGHTNING_LORA_REPO else "no LoRA configured"
        active_adapters = []
        if LIGHTNING_LORA_REPO:
            try:
                self.pipe.load_lora_weights(
                    LIGHTNING_LORA_REPO,
                    subfolder=LIGHTNING_LORA_SUBFOLDER,
                    weight_name="high_noise_model.safetensors",
                    adapter_name="lightning_high",
                    cache_dir="/cache/hf",
                )
                self.pipe.load_lora_weights(
                    LIGHTNING_LORA_REPO,
                    subfolder=LIGHTNING_LORA_SUBFOLDER,
                    weight_name="low_noise_model.safetensors",
                    adapter_name="lightning_low",
                    load_into_transformer_2=True,
                    cache_dir="/cache/hf",
                )
                active_adapters += ["lightning_high", "lightning_low"]
                self.fast = True
            except Exception as exc:
                self.lora_error = f"{type(exc).__name__}: {exc}"
                print(f"Lightning LoRA unavailable ({exc!r}); using full steps.", flush=True)

        self.nsfw_available = False
        self.nsfw_lora_error = None if NSFW_LORA_REPO else "no NSFW LoRA configured"
        if NSFW_LORA_REPO:
            try:
                if NSFW_LORA_HIGH_FILE and NSFW_LORA_LOW_FILE:
                    high_file, low_file = NSFW_LORA_HIGH_FILE, NSFW_LORA_LOW_FILE
                    all_files = None
                else:
                    high_file, low_file, all_files = _find_lora_files(NSFW_LORA_REPO)
                if not (high_file and low_file):
                    raise ValueError(
                        f"could not identify high/low weight files in {NSFW_LORA_REPO} "
                        f"(repo contains: {all_files})"
                    )
                self.pipe.load_lora_weights(
                    NSFW_LORA_REPO,
                    weight_name=high_file,
                    adapter_name="nsfw_high",
                    cache_dir="/cache/hf",
                )
                self.pipe.load_lora_weights(
                    NSFW_LORA_REPO,
                    weight_name=low_file,
                    adapter_name="nsfw_low",
                    load_into_transformer_2=True,
                    cache_dir="/cache/hf",
                )
                active_adapters += ["nsfw_high", "nsfw_low"]
                self.nsfw_available = True
            except Exception as exc:
                self.nsfw_lora_error = f"{type(exc).__name__}: {exc}"
                print(f"NSFW LoRA unavailable ({exc!r}).", flush=True)

        if active_adapters:
            self.pipe.set_adapters(active_adapters)

        self.pipe.enable_model_cpu_offload()

    @modal.method()
    def ping(self) -> dict:
        return {
            "ready": True,
            "fast": self.fast,
            "lora_error": self.lora_error,
            "nsfw_available": self.nsfw_available,
            "nsfw_lora_error": self.nsfw_lora_error,
        }

    @modal.method()
    def run(
        self,
        prompt: str,
        image: str,
        negative_prompt: str = "",
        width: int = 1280,
        height: int = 720,
        num_frames: int = FRAMES_PER_CLIP,
        fps: int = DEFAULT_FPS,
        seed: int = 42,
        steps: int | None = None,
        guidance_scale: float | None = None,
        polish: bool = True,
        nsfw: bool = True,
        # See wan_a14b_app.py's run() for why this exists: set_adapters() at
        # load() fixed the adapter list for the container's life, so every
        # call got Lightning's weights merged in regardless of steps/
        # guidance_scale — real CFG through a LoRA distilled for CFG-1
        # produces burnt frames, and it also crowds out the NSFW LoRA
        # stacked alongside it. False detaches Lightning per-call instead.
        use_lightning: bool | None = None,
        nsfw_scale: float = 1.0,  # 1.0 = as trained; turn down instead of off if it's too strong
    ) -> dict:
        import torch
        from diffusers.utils import export_to_video

        started = time.time()
        seed_frame = _decode_image(image)
        if seed_frame is None:
            raise ValueError("This app is image-to-video only — 'image' is required.")
        seed_frame = seed_frame.resize((width, height))

        num_frames = max(5, min(MAX_FRAMES, ((int(num_frames) - 1) // 4) * 4 + 1))
        use_speed = self.fast if use_lightning is None else (use_lightning and self.fast)
        if steps is None:
            steps = FAST_STEPS if use_speed else FULL_STEPS
        if guidance_scale is None:
            guidance_scale = FAST_GUIDANCE if use_speed else FULL_GUIDANCE

        use_nsfw = nsfw and self.nsfw_available
        run_prompt = f"{prompt}, {NSFW_LORA_TRIGGER}" if use_nsfw and NSFW_LORA_TRIGGER else prompt
        nsfw_scale = max(0.0, min(2.0, float(nsfw_scale)))

        wanted, weights = [], []
        if use_speed:
            wanted += ["lightning_high", "lightning_low"]
            weights += [1.0, 1.0]
        if use_nsfw:
            wanted += ["nsfw_high", "nsfw_low"]
            weights += [nsfw_scale, nsfw_scale]
        self.pipe.set_adapters(wanted, adapter_weights=weights) if wanted else self.pipe.disable_lora()

        frames = self.pipe(
            image=seed_frame,
            prompt=run_prompt,
            negative_prompt=negative_prompt or None,
            width=width,
            height=height,
            num_frames=num_frames,
            num_inference_steps=steps,
            guidance_scale=guidance_scale,
            generator=torch.Generator("cpu").manual_seed(seed),
            output_type="pil",
        ).frames[0]

        path = "/tmp/out.mp4"
        out_fps = _export_polished(frames, path, fps) if polish else fps
        if not polish:
            export_to_video(frames, path, fps=fps)
        with open(path, "rb") as fh:
            video_b64 = base64.b64encode(fh.read()).decode()

        return {
            "video_base64": video_b64,
            "elapsed_seconds": round(time.time() - started, 2),
            "num_clips": 1,
            "num_frames": len(frames),
            "fps": out_fps,
            "fast": self.fast,
            "lightning_used": use_speed,
            "steps": steps,
            "guidance_scale": guidance_scale,
            "lora_error": self.lora_error,
            "polished": polish,
            "nsfw_used": use_nsfw,
            "nsfw_scale": nsfw_scale if use_nsfw else None,
            "nsfw_lora_error": self.nsfw_lora_error,
        }


@app.function(image=image, timeout=3600)
@modal.fastapi_endpoint(method="POST")
def generate(payload: dict) -> dict:
    prompt = (payload.get("prompt") or "").strip()
    image_b64 = payload.get("image") or ""
    if not image_b64:
        return {"error": "Missing 'image' — this app is image-to-video only."}

    try:
        return WanA14BI2V().run.remote(
            prompt=prompt,
            image=image_b64,
            negative_prompt=payload.get("negative_prompt") or "",
            width=int(payload.get("width") or 1280),
            height=int(payload.get("height") or 720),
            num_frames=int(payload.get("num_frames") or FRAMES_PER_CLIP),
            fps=int(payload.get("fps") or DEFAULT_FPS),
            seed=int(payload["seed"]) if payload.get("seed") else random.randint(1, 2**31 - 1),
            steps=int(payload["steps"]) if payload.get("steps") else None,
            guidance_scale=(
                float(payload["guidance_scale"]) if payload.get("guidance_scale") else None
            ),
            **({"polish": payload["polish"]} if "polish" in payload else {}),
            **({"nsfw": payload["nsfw"]} if "nsfw" in payload else {}),
            **({"use_lightning": payload["use_lightning"]} if "use_lightning" in payload else {}),
            **({"nsfw_scale": float(payload["nsfw_scale"])} if "nsfw_scale" in payload else {}),
        )
    except Exception as exc:
        import traceback

        return {
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": "".join(traceback.format_exc()).strip()[-3000:],
        }


@app.function(image=image, timeout=60)
@modal.fastapi_endpoint(method="POST")
def warm() -> dict:
    try:
        WanA14BI2V().ping.spawn()
        return {"warming": True}
    except Exception as exc:
        return {"warming": False, "error": f"{type(exc).__name__}: {exc}"}


# Diagnostic, not a warmup — see module docstring. Blocks on the cold start
# so it can hand back whether the NSFW LoRA actually loaded before anyone
# spends a real generation finding out the hard way.
@app.function(image=image, timeout=120)
@modal.fastapi_endpoint(method="POST")
def status() -> dict:
    try:
        return WanA14BI2V().ping.remote()
    except Exception as exc:
        import traceback

        return {
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": "".join(traceback.format_exc()).strip()[-3000:],
        }


@app.function(image=image, timeout=60)
@modal.fastapi_endpoint(method="POST")
def submit(payload: dict) -> dict:
    image_b64 = payload.get("image") or ""
    if not image_b64:
        return {"error": "Missing 'image' — this app is image-to-video only."}

    try:
        call = WanA14BI2V().run.spawn(
            prompt=(payload.get("prompt") or "").strip(),
            image=image_b64,
            negative_prompt=payload.get("negative_prompt") or "",
            width=int(payload.get("width") or 1280),
            height=int(payload.get("height") or 720),
            num_frames=int(payload.get("num_frames") or FRAMES_PER_CLIP),
            fps=int(payload.get("fps") or DEFAULT_FPS),
            seed=int(payload["seed"]) if payload.get("seed") else random.randint(1, 2**31 - 1),
            steps=int(payload["steps"]) if payload.get("steps") else None,
            guidance_scale=(
                float(payload["guidance_scale"]) if payload.get("guidance_scale") else None
            ),
            **({"polish": payload["polish"]} if "polish" in payload else {}),
            **({"nsfw": payload["nsfw"]} if "nsfw" in payload else {}),
            **({"use_lightning": payload["use_lightning"]} if "use_lightning" in payload else {}),
            **({"nsfw_scale": float(payload["nsfw_scale"])} if "nsfw_scale" in payload else {}),
        )
        return {"job_id": call.object_id, "status": "running"}
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


@app.function(image=image, timeout=60)
@modal.fastapi_endpoint(method="POST")
def result(payload: dict) -> dict:
    job_id = (payload.get("job_id") or "").strip()
    if not job_id:
        return {"error": "Missing 'job_id'."}

    try:
        call = modal.FunctionCall.from_id(job_id)
    except Exception as exc:
        return {"status": "error", "error": f"Unknown job: {exc}"}

    try:
        out = call.get(timeout=0)
    except modal.exception.OutputExpiredError:
        return {"status": "expired",
                "error": "Result expired on Modal before it was collected."}
    except TimeoutError:
        return {"status": "running"}
    except Exception as exc:
        return {"status": "error", "error": f"{type(exc).__name__}: {exc}"}

    return {"status": "done", **out}
