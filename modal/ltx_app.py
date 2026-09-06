"""
LTX-Video text-to-video on Modal — the `ltx-video` app.

Serves POST https://ic4pi--ltx-video-generate.modal.run, consumed by
generateModalLtxVideo() in api/media-generate.js. Same request/response
contract and clip-chaining approach as wan_app.py; LTX is the faster, lighter
model, which is why the Studio picker allows it 30s against Wan's 5s.

    request   {prompt, negative_prompt?, width, height, num_frames, fps, num_clips}
    response  {video_base64, elapsed_seconds, num_clips}

Deploy:  modal deploy modal/ltx_app.py

!! RECONSTRUCTED — see modal/README.md before deploying over a working app. !!
"""

import base64
import os
import time

import modal

MODEL_ID = "Lightricks/LTX-Video"

MAX_CLIPS = 6
FRAMES_PER_CLIP = 121  # ~5s at 24fps; LTX needs 8k+1
DEFAULT_FPS = 24

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "torch==2.6.0",
        "diffusers==0.36.0",
        "transformers==4.51.3",
        "accelerate==1.6.0",
        "safetensors",
        "sentencepiece",
        "imageio",
        "imageio-ffmpeg",
        "pillow",
        "fastapi[standard]",
    )
)

app = modal.App("ltx-video")
cache = modal.Volume.from_name("ltx-model-cache", create_if_missing=True)


def _round_to(value: int, multiple: int, minimum: int) -> int:
    """LTX rejects dimensions that are not multiples of 32."""
    return max(minimum, int(round(value / multiple)) * multiple)


@app.cls(
    gpu="L4",
    image=image,
    volumes={"/cache": cache},
    scaledown_window=300,
    timeout=3600,
)
class LTX:
    @modal.enter()
    def load(self):
        import torch
        from diffusers import LTXImageToVideoPipeline, LTXPipeline

        os.environ["HF_HOME"] = "/cache/hf"

        self.t2v = LTXPipeline.from_pretrained(
            MODEL_ID, torch_dtype=torch.bfloat16, cache_dir="/cache/hf"
        )
        # Built from the loaded components rather than a second from_pretrained,
        # so chaining costs no extra VRAM or cold-start download.
        self.i2v = LTXImageToVideoPipeline(
            scheduler=self.t2v.scheduler,
            vae=self.t2v.vae,
            text_encoder=self.t2v.text_encoder,
            tokenizer=self.t2v.tokenizer,
            transformer=self.t2v.transformer,
        )
        # LTX is ~15GB in bf16 (T5-XXL dominates) against the L4's 24GB, so it
        # may well run resident like SDXL does — but 121-frame activations make
        # that too close to call without measuring, and an OOM costs more than
        # the offload does. Off by default; flip and time it.
        if os.environ.get("LTX_CPU_OFFLOAD") == "0":
            self.t2v.to("cuda")
            self.i2v.to("cuda")
        else:
            self.t2v.enable_model_cpu_offload()
            self.i2v.enable_model_cpu_offload()

    @modal.method()
    def ping(self) -> dict:
        """Warm-up target. Does no work — @modal.enter() has already loaded the
        weights by the time this runs, which is the entire point. Spawning
        run() instead would generate (and bill for) a real clip."""
        return {"ready": True}

    @modal.method()
    def run(
        self,
        prompt: str,
        negative_prompt: str = "",
        width: int = 704,
        height: int = 480,
        num_frames: int = FRAMES_PER_CLIP,
        fps: int = DEFAULT_FPS,
        num_clips: int = 1,
        seed: int = 42,
        steps: int = 30,  # measured: 30 steps, ~2min for one 5s clip
        guidance_scale: float = 3.0,
    ) -> dict:
        import torch
        from diffusers.utils import export_to_video

        started = time.time()
        num_clips = max(1, min(MAX_CLIPS, int(num_clips)))

        width = _round_to(width, 32, 256)
        height = _round_to(height, 32, 256)
        # 8k+1 or the transformer's temporal patching rejects the request.
        num_frames = max(9, ((int(num_frames) - 1) // 8) * 8 + 1)

        frames: list = []
        seed_frame = None

        for clip in range(num_clips):
            generator = torch.Generator("cpu").manual_seed(seed + clip)
            common = dict(
                prompt=prompt,
                negative_prompt=negative_prompt or None,
                width=width,
                height=height,
                num_frames=num_frames,
                frame_rate=fps,
                num_inference_steps=steps,
                guidance_scale=guidance_scale,
                generator=generator,
                output_type="pil",
            )
            if seed_frame is None:
                out = self.t2v(**common).frames[0]
            else:
                out = self.i2v(image=seed_frame, **common).frames[0]
                out = out[1:]  # frame 0 is the seed frame itself

            frames.extend(out)
            seed_frame = frames[-1]

        path = "/tmp/out.mp4"
        export_to_video(frames, path, fps=fps)
        with open(path, "rb") as fh:
            video_b64 = base64.b64encode(fh.read()).decode()

        return {
            "video_base64": video_b64,
            "elapsed_seconds": round(time.time() - started, 2),
            "num_clips": num_clips,
            "num_frames": len(frames),
            "fps": fps,
        }


@app.function(image=image, timeout=3600)
@modal.fastapi_endpoint(method="POST")
def generate(payload: dict) -> dict:
    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        return {"error": "Missing 'prompt'."}

    try:
        return LTX().run.remote(
            prompt=prompt,
            negative_prompt=payload.get("negative_prompt") or "",
            width=int(payload.get("width") or 704),
            height=int(payload.get("height") or 480),
            num_frames=int(payload.get("num_frames") or FRAMES_PER_CLIP),
            fps=int(payload.get("fps") or DEFAULT_FPS),
            num_clips=int(payload.get("num_clips") or 1),
            seed=int(payload.get("seed") or 42),
        )
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


@app.function(image=image, timeout=60)
@modal.fastapi_endpoint(method="POST")
def warm() -> dict:
    """Kick a container into existence so @modal.enter() loads the weights.

    The browser calls this the moment someone focuses the prompt box, which
    buys ~60s of cold start back against time they were going to spend typing
    anyway. spawn() rather than remote() so it returns immediately instead of
    blocking the page for the whole load."""
    try:
        LTX().ping.spawn()
        return {"warming": True}
    except Exception as exc:
        return {"warming": False, "error": f"{type(exc).__name__}: {exc}"}


# ---- Async job API -------------------------------------------------------
# The synchronous `generate` endpoint is bounded by the caller's own function
# timeout — 800s on Vercel — which is what caps clip length, not the model.
# Splitting submit from result makes every HTTP request short, so length is
# bounded only by this app's own timeout instead.
#
# Modal keeps the spawned call's result server-side; from_id re-attaches to it
# by id, so the polling request does not need the original handle.


@app.function(image=image, timeout=60)
@modal.fastapi_endpoint(method="POST")
def submit(payload: dict) -> dict:
    """Start a generation and return immediately with its job id."""
    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        return {"error": "Missing 'prompt'."}

    try:
        call = LTX().run.spawn(
            prompt=prompt,
            negative_prompt=payload.get("negative_prompt") or "",
            width=int(payload.get("width") or 704),
            height=int(payload.get("height") or 480),
            num_frames=int(payload.get("num_frames") or FRAMES_PER_CLIP),
            fps=int(payload.get("fps") or DEFAULT_FPS),
            num_clips=int(payload.get("num_clips") or 1),
            seed=int(payload.get("seed") or 42),
        )
        return {"job_id": call.object_id, "status": "running"}
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


@app.function(image=image, timeout=60)
@modal.fastapi_endpoint(method="POST")
def result(payload: dict) -> dict:
    """Poll a job. Returns status "running" until the clip is ready.

    timeout=0 makes this a non-blocking check: Modal raises rather than
    holding the connection open, which is the whole point — a polling request
    that blocked would just move the timeout problem instead of solving it."""
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
        # Modal drops results some time after completion. Nothing to recover.
        return {"status": "expired",
                "error": "Result expired on Modal before it was collected."}
    except TimeoutError:
        return {"status": "running"}
    except Exception as exc:
        return {"status": "error", "error": f"{type(exc).__name__}: {exc}"}

    return {"status": "done", **out}
