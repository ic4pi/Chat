"""
Wan 2.2 A14B text-to-video on Modal — experimental `wan-video-a14b` app.

TI2V-5B (wan_app.py) has two hard ceilings that turned out not to be code
bugs: its Lightning LoRA can never exist (no TI2V-5B build of it — see
wan_app.py's LIGHTNING_LORA_REPO comment), and even fixed and post-processed
(interpolation + upscale), its raw generation quality was judged unusable.

A14B is the actual model the Lightning LoRA in lightx2v/Wan2.2-Lightning
targets, and it is ~3x the parameters (14B vs 5B, as two 14B experts —
high-noise and low-noise — switched by timestep). This is the real lever on
quality; TI2V-5B's problems were not something more code could fix.

Text-to-video only, single clip. Unlike the 5B app, there is no combined
TI2V checkpoint here — T2V-A14B and I2V-A14B are two separate 14B-parameter
models, each with two experts. Holding both resident (four 14B transformers)
for clip-chaining the way wan_app.py does would need ~110GB+ of VRAM just for
transformers. One clip at a higher frame count is the tradeoff instead.

Needs an A100-80GB: the two 14B experts alone are ~56GB in bf16, before the
text encoder, VAE, and activations. This is the expensive option — L4/A100-40GB
will not fit it. Real GPU cost per clip, not the near-free L4 apps.

Deploy:  modal deploy modal/wan_a14b_app.py
"""

import base64
import os
import time

import modal

MODEL_ID = "Wan-AI/Wan2.2-T2V-A14B-Diffusers"

# The only Wan Lightning LoRA that actually exists ships two separate weight
# files — one per expert — because A14B is a mixture of two 14B transformers
# switched by timestep (see boundary_ratio in the repo's model_index.json).
# Loading only one half would leave the other expert running unaccelerated
# and mismatched in style, so both are loaded onto their respective experts
# and left as switchable adapters (not fused), like sdxl_app.py's Lightning.
LIGHTNING_LORA_REPO = os.environ.get("WAN_A14B_LIGHTNING_LORA_REPO", "lightx2v/Wan2.2-Lightning")
LIGHTNING_LORA_SUBFOLDER = os.environ.get(
    "WAN_A14B_LIGHTNING_LORA_SUBFOLDER", "Wan2.2-T2V-A14B-4steps-lora-250928"
)

FAST_STEPS = 4
FAST_GUIDANCE = 1.0
FULL_STEPS = 40
FULL_GUIDANCE = 4.0  # A14B's own recommended default, not the 5B app's 5.0

DEFAULT_FPS = 16
FRAMES_PER_CLIP = 81  # ~5s at 16fps, matching the 5B app's convention

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "av",
        "torch==2.6.0",
        "diffusers==0.36.0",
        "transformers==4.51.3",
        "accelerate==1.6.0",
        # diffusers routes load_lora_weights through peft.
        "peft==0.17.1",
        "safetensors",
        "sentencepiece",
        "ftfy",
        "imageio",
        "imageio-ffmpeg",
        "pillow",
        "fastapi[standard]",
    )
)

app = modal.App(os.environ.get("MODAL_APP_NAME", "wan-video-a14b"))
cache = modal.Volume.from_name("wan-a14b-model-cache", create_if_missing=True)


def _export_polished(frames, path: str, fps: int, upscale: int = 2) -> int:
    """Same post pass as wan_app.py — see that file for the rationale."""
    from diffusers.utils import export_to_video

    raw_path = path + ".raw.mp4"
    export_to_video(frames, raw_path, fps=fps)
    out_fps = fps * 2
    vf = (
        f"scale=iw*{upscale}:ih*{upscale}:flags=lanczos,"
        f"minterpolate=fps={out_fps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1"
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
class WanA14B:
    @modal.enter()
    def load(self):
        import torch
        from diffusers import WanPipeline

        os.environ["HF_HOME"] = "/cache/hf"

        self.pipe = WanPipeline.from_pretrained(
            MODEL_ID, torch_dtype=torch.bfloat16, cache_dir="/cache/hf"
        )

        # A failure here must not take generation down — falls back to full
        # steps at the model's own guidance, which is slow but correct.
        self.fast = False
        self.lora_error = None if LIGHTNING_LORA_REPO else "no LoRA configured"
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
                self.pipe.set_adapters(["lightning_high", "lightning_low"])
                self.fast = True
            except Exception as exc:
                self.lora_error = f"{type(exc).__name__}: {exc}"
                print(f"Lightning LoRA unavailable ({exc!r}); using full steps.", flush=True)

        # 56GB of experts alone against an 80GB card — offload keeps headroom
        # for activations at 720p instead of cutting it close.
        self.pipe.enable_model_cpu_offload()

    @modal.method()
    def ping(self) -> dict:
        return {"ready": True}

    @modal.method()
    def run(
        self,
        prompt: str,
        negative_prompt: str = "",
        width: int = 1280,
        height: int = 720,
        num_frames: int = FRAMES_PER_CLIP,
        fps: int = DEFAULT_FPS,
        seed: int = 42,
        steps: int | None = None,
        guidance_scale: float | None = None,
        polish: bool = True,
    ) -> dict:
        import torch
        from diffusers.utils import export_to_video

        started = time.time()
        if steps is None:
            steps = FAST_STEPS if self.fast else FULL_STEPS
        if guidance_scale is None:
            guidance_scale = FAST_GUIDANCE if self.fast else FULL_GUIDANCE

        frames = self.pipe(
            prompt=prompt,
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
            "steps": steps,
            "lora_error": self.lora_error,
            "polished": polish,
        }


@app.function(image=image, timeout=3600)
@modal.fastapi_endpoint(method="POST")
def generate(payload: dict) -> dict:
    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        return {"error": "Missing 'prompt'."}

    try:
        return WanA14B().run.remote(
            prompt=prompt,
            negative_prompt=payload.get("negative_prompt") or "",
            width=int(payload.get("width") or 1280),
            height=int(payload.get("height") or 720),
            num_frames=int(payload.get("num_frames") or FRAMES_PER_CLIP),
            fps=int(payload.get("fps") or DEFAULT_FPS),
            seed=int(payload.get("seed") or 42),
            steps=int(payload["steps"]) if payload.get("steps") else None,
            guidance_scale=(
                float(payload["guidance_scale"]) if payload.get("guidance_scale") else None
            ),
            **({"polish": payload["polish"]} if "polish" in payload else {}),
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
        WanA14B().ping.spawn()
        return {"warming": True}
    except Exception as exc:
        return {"warming": False, "error": f"{type(exc).__name__}: {exc}"}


@app.function(image=image, timeout=60)
@modal.fastapi_endpoint(method="POST")
def submit(payload: dict) -> dict:
    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        return {"error": "Missing 'prompt'."}

    try:
        call = WanA14B().run.spawn(
            prompt=prompt,
            negative_prompt=payload.get("negative_prompt") or "",
            width=int(payload.get("width") or 1280),
            height=int(payload.get("height") or 720),
            num_frames=int(payload.get("num_frames") or FRAMES_PER_CLIP),
            fps=int(payload.get("fps") or DEFAULT_FPS),
            seed=int(payload.get("seed") or 42),
            **({"polish": payload["polish"]} if "polish" in payload else {}),
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
