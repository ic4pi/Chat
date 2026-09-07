"""
Wan 2.2 TI2V-5B text-to-video on Modal — the `wan-video` app.

Serves POST https://ic4pi--wan-video-generate.modal.run, consumed by
generateModalWanVideo() in api/media-generate.js.

    request   {prompt, negative_prompt?, width, height, num_frames, fps, num_clips}
    response  {video_base64, elapsed_seconds, num_clips}

Long requests exceed the synchronous web-endpoint window, at which point Modal
returns 303 to a result URL. The caller uses fetch(), which follows that
redirect and correctly switches to GET — see the note in media-generate.js.

Deploy:  modal deploy modal/wan_app.py

!! RECONSTRUCTED — see modal/README.md before deploying over a working app. !!
"""

import base64
import io
import os
import subprocess
import tempfile
import time

import modal

MODEL_ID = "Wan-AI/Wan2.2-TI2V-5B-Diffusers"

# Clips are chained rather than generated as one long video: quality and speed
# per clip stay flat, where a single long generation degrades and risks the
# container timeout. Mirrored by the client, which also caps at 6.
MAX_CLIPS = 6
FRAMES_PER_CLIP = 81  # ~5s at 16fps; Wan needs 4k+1
DEFAULT_FPS = 16

# Lightning is a step-distilled LoRA: it collapses the sampler from 40 steps to
# ~4 AND removes the need for classifier-free guidance. Dropping CFG halves the
# transformer evaluations again (no unconditional pass), so the two together cut
# roughly an order of magnitude off a clip. guidance_scale MUST be 1.0 with it —
# a distilled model given real CFG produces burnt, oversaturated frames.
#
# Set LIGHTNING_LORA_REPO="" to deploy without it and fall back to full steps.
LIGHTNING_LORA_REPO = os.environ.get(
    "WAN_LIGHTNING_LORA_REPO", "lightx2v/Wan2.2-Lightning"
)
LIGHTNING_LORA_WEIGHT = os.environ.get("WAN_LIGHTNING_LORA_WEIGHT", "")

FAST_STEPS = 4
FAST_GUIDANCE = 1.0
FULL_STEPS = 40      # measured: 832x480, ~6m20s for one 5s clip
FULL_GUIDANCE = 5.0

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "av",
        "torch==2.6.0",
        "diffusers==0.36.0",
        "transformers==4.51.3",
        "accelerate==1.6.0",
        # diffusers routes load_lora_weights through peft; without it
        # every Lightning LoRA here silently falls back to full steps.
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

# Deploy alongside the existing app instead of over it:
#   MODAL_APP_NAME=wan-video-v2 modal deploy modal/wan_app.py
# The site picks the target with MODAL_*_ENDPOINT, so switching back is
# deleting an env var rather than redeploying.
# GPU. The L4 is the cheap card and the slow one: SDXL 4x1024px takes ~57s on
# it, and an LTX clip runs into minutes. Diffusion is bandwidth-bound and the
# A100 has ~5x the memory bandwidth, so it is roughly 3-4x faster for ~3.5x
# the hourly rate - close to cost-neutral per image on a scale-to-zero app,
# bought purely as latency. Override per deploy with MODAL_GPU=L4.
GPU = os.environ.get("MODAL_GPU", "A100")

def _peft_version():
    """Which peft the *serving container* has, or None.

    A Modal deploy does not evict warm containers: for up to
    scaledown_window seconds afterwards, requests can still be answered by a
    container running the previous image. That cost two cycles here - a fix
    was deployed, the next request was served by the old container, and the
    unchanged error read as "the fix did not work". Reporting the version the
    answering container actually has makes the difference visible.
    """
    try:
        import peft

        return peft.__version__
    except Exception:
        return None


app = modal.App(os.environ.get("MODAL_APP_NAME", "wan-video"))
cache = modal.Volume.from_name("wan-model-cache", create_if_missing=True)

# Optional Hugging Face token. A token lifts Hub rate limits, which is what
# turns a cold start into "model is not cached locally and an error occurred
# while trying to fetch metadata from the Hub".
#
# Opt in by NAME, never by try/except: Secret.from_name() is lazy, so a
# missing secret does not raise here — it fails the whole deploy later. Off
# unless asked for:
#   modal secret create huggingface-secret HF_TOKEN=hf_...
#   MODAL_HF_SECRET=huggingface-secret modal deploy modal/sdxl_app.py
_hf_secret_name = os.environ.get("MODAL_HF_SECRET", "").strip()
hf_secret = [modal.Secret.from_name(_hf_secret_name)] if _hf_secret_name else []


def download_weights():
    """Populate the cache volume at deploy time.

    Otherwise the first request to a cold container is also the first ~10GB
    download from the Hub, inside the request path — a slow or rate-limited
    Hub then fails the request instead of merely slowing it.

    snapshot_download rather than from_pretrained: this runs on a CPU builder
    and only needs the files on disk, not a pipeline instantiated in RAM.
    """
    from huggingface_hub import snapshot_download

    dupes = ["*.bin", "*.ckpt", "*.msgpack", "*.onnx", "*.h5"]

    print(f"caching {MODEL_ID}", flush=True)
    snapshot_download(MODEL_ID, cache_dir="/cache/hf", ignore_patterns=dupes)

    if LIGHTNING_LORA_REPO:
        try:
            print(f"caching LoRA {LIGHTNING_LORA_REPO}", flush=True)
            snapshot_download(LIGHTNING_LORA_REPO, cache_dir="/cache/hf")
        except Exception as exc:  # the LoRA is a speed-up, not a requirement
            print(f"Lightning LoRA not pre-cached: {exc}", flush=True)

    cache.commit()
    print("weights cached", flush=True)


# Runs during `modal deploy`, writing straight into the volume the serving
# class mounts, so a cold container finds the weights already on disk.
image = image.env({"HF_HOME": "/cache/hf"}).run_function(
    download_weights, volumes={"/cache": cache}, secrets=hf_secret, timeout=3600
)


def _video_to_frames(data: str, width: int, height: int, max_frames: int):
    """Decode a base64 mp4 into PIL frames at the model's own geometry.

    Sampled evenly rather than truncated: restyling the first two seconds of a
    ten-second clip and calling it done would silently drop most of the input.
    """
    import imageio.v3 as iio
    from PIL import Image

    if data.startswith("data:"):
        data = data.split(",", 1)[-1]

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as fh:
        fh.write(base64.b64decode(data))
        path = fh.name

    raw = [Image.fromarray(f) for f in iio.imiter(path, plugin="pyav")]
    os.unlink(path)
    if not raw:
        raise ValueError("Could not read any frames from the uploaded video.")

    if len(raw) > max_frames:
        step = len(raw) / max_frames
        raw = [raw[min(len(raw) - 1, int(i * step))] for i in range(max_frames)]

    return [f.convert("RGB").resize((width, height), Image.LANCZOS) for f in raw]


@app.cls(
    gpu=GPU,
    image=image,
    volumes={"/cache": cache},
    # Weights are ~10GB off a cold volume; a short window makes every request
    # after an idle gap pay that again. 5 min keeps a working session warm
    # while still scaling to zero, which is the whole point of this being here
    # rather than on an always-on box.
    scaledown_window=300,
    timeout=3600,
    secrets=hf_secret,
)
class Wan:
    @modal.enter()
    def load(self):
        import torch
        from diffusers import AutoencoderKLWan, WanImageToVideoPipeline, WanPipeline

        os.environ["HF_HOME"] = "/cache/hf"

        # The VAE stays fp32. In bf16 it produces washed-out, artefacted frames,
        # which then propagate through the whole chain via the seed frame.
        vae = AutoencoderKLWan.from_pretrained(
            MODEL_ID, subfolder="vae", torch_dtype=torch.float32, cache_dir="/cache/hf"
        )
        self.t2v = WanPipeline.from_pretrained(
            MODEL_ID, vae=vae, torch_dtype=torch.bfloat16, cache_dir="/cache/hf"
        )
        # Built with from_pretrained, not by hand from the t2v components.
        # Constructing the class directly skips the repo's own config, so the
        # pipeline fell back to Wan 2.1's image conditioning - latent, masked
        # latent and mask concatenated on the channel axis - and handed the
        # transformer 100 channels (48 + 48 + 4) where TI2V-5B takes 48:
        #
        #   RuntimeError: Given groups=1, weight of size [3072, 48, 1, 2, 2],
        #   expected input[1, 100, 21, 30, 52] to have 48 channels, but got 100
        #
        # Clip one is text-to-video and renders fine; every clip after it seeds
        # from the previous frame through this pipeline, so any multi-clip
        # request died partway with weights already paid for. Passing the
        # loaded components keeps it to one set of weights in VRAM.
        self.i2v = WanImageToVideoPipeline.from_pretrained(
            MODEL_ID,
            vae=self.t2v.vae,
            transformer=self.t2v.transformer,
            text_encoder=self.t2v.text_encoder,
            tokenizer=self.t2v.tokenizer,
            scheduler=self.t2v.scheduler,
            torch_dtype=torch.bfloat16,
            cache_dir="/cache/hf",
        )
        # Loaded onto the shared transformer, so both pipelines get it.
        # A failure here must not take generation down — it falls back to full
        # steps, which is slow but correct, and says so in the response.
        self.fast = False
        self.lora_error = None if LIGHTNING_LORA_REPO else "no LoRA configured"
        if LIGHTNING_LORA_REPO:
            try:
                kwargs = {"cache_dir": "/cache/hf"}
                if LIGHTNING_LORA_WEIGHT:
                    kwargs["weight_name"] = LIGHTNING_LORA_WEIGHT
                self.t2v.load_lora_weights(LIGHTNING_LORA_REPO, **kwargs)
                self.t2v.fuse_lora()
                self.fast = True
            except Exception as exc:
                # Into the response, not just Modal's logs: a silent fallback
                # to 40 steps is a 10x slowdown that looks identical to
                # "video is just slow" from the outside.
                self.lora_error = f"{type(exc).__name__}: {exc}"
                print(f"Lightning LoRA unavailable ({exc!r}); using full steps.")

        # Restyling an existing clip. Shares the loaded components, so it adds
        # no VRAM and no cold start.
        from diffusers import WanVideoToVideoPipeline

        self.v2v = WanVideoToVideoPipeline(
            tokenizer=self.t2v.tokenizer,
            text_encoder=self.t2v.text_encoder,
            vae=self.t2v.vae,
            scheduler=self.t2v.scheduler,
            transformer=self.t2v.transformer,
        )

        self.t2v.enable_model_cpu_offload()
        self.i2v.enable_model_cpu_offload()
        self.v2v.enable_model_cpu_offload()

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
        width: int = 832,
        height: int = 480,
        num_frames: int = FRAMES_PER_CLIP,
        fps: int = DEFAULT_FPS,
        num_clips: int = 1,
        seed: int = 42,
        steps: int | None = None,
        guidance_scale: float | None = None,
        video: str = "",
        strength: float = 0.6,
    ) -> dict:
        import torch
        from diffusers.utils import export_to_video

        started = time.time()
        # Re-clamped here, not just client-side: the endpoint is reachable
        # directly and a 20-clip request would run until the timeout.
        num_clips = max(1, min(MAX_CLIPS, int(num_clips)))

        # Whether the LoRA loaded decides the sampler settings, not the caller —
        # 4 steps without it is noise, and CFG with it is burnt frames.
        if steps is None:
            steps = FAST_STEPS if self.fast else FULL_STEPS
        if guidance_scale is None:
            guidance_scale = FAST_GUIDANCE if self.fast else FULL_GUIDANCE

        # Restyling a supplied clip is a single pass, not a chain: the source
        # already carries the motion the chain exists to invent, and chaining
        # would restyle a clip that is itself already a restyle.
        if video:
            source = _video_to_frames(video, width, height, num_frames)
            styled = self.v2v(
                video=source,
                prompt=prompt,
                negative_prompt=negative_prompt or None,
                height=height,
                width=width,
                num_inference_steps=steps,
                guidance_scale=guidance_scale,
                # How far from the source. Low values only shift surface
                # appearance; high values redraw and lose the original motion.
                strength=max(0.05, min(1.0, float(strength))),
                generator=torch.Generator("cpu").manual_seed(seed),
                output_type="pil",
            ).frames[0]

            path = "/tmp/out.mp4"
            export_to_video(styled, path, fps=fps)
            with open(path, "rb") as fh:
                video_b64 = base64.b64encode(fh.read()).decode()
            return {
                "video_base64": video_b64,
                "elapsed_seconds": round(time.time() - started, 2),
                "num_clips": 1,
                "num_frames": len(styled),
                "fps": fps,
                "mode": "video2video",
                "fast": self.fast,
                "steps": steps,
            }

        frames: list = []
        seed_frame = None

        for clip in range(num_clips):
            generator = torch.Generator("cpu").manual_seed(seed + clip)
            common = dict(
                prompt=prompt,
                negative_prompt=negative_prompt or None,
                height=height,
                width=width,
                num_frames=num_frames,
                num_inference_steps=steps,
                guidance_scale=guidance_scale,
                generator=generator,
                output_type="pil",
            )
            if seed_frame is None:
                out = self.t2v(**common).frames[0]
            else:
                out = self.i2v(image=seed_frame, **common).frames[0]
                # The i2v pipeline reproduces its input as frame 0, so keeping
                # it would freeze one frame at every clip boundary.
                out = out[1:]

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
            "fast": self.fast,
            "steps": steps,
            "lora_error": self.lora_error,
            "peft": _peft_version(),
        }


@app.function(image=image, timeout=3600)
@modal.fastapi_endpoint(method="POST")
def generate(payload: dict) -> dict:
    """Thin CPU front door. Named `generate` because the deployed URL that
    api/media-generate.js targets is ic4pi--wan-video-generate.modal.run."""
    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        return {"error": "Missing 'prompt'."}

    try:
        return Wan().run.remote(
            prompt=prompt,
            negative_prompt=payload.get("negative_prompt") or "",
            width=int(payload.get("width") or 832),
            height=int(payload.get("height") or 480),
            num_frames=int(payload.get("num_frames") or FRAMES_PER_CLIP),
            fps=int(payload.get("fps") or DEFAULT_FPS),
            num_clips=int(payload.get("num_clips") or 1),
            seed=int(payload.get("seed") or 42),
            video=payload.get("video") or "",
            strength=float(payload.get("strength") or 0.6),
        )
    except Exception as exc:  # surfaced verbatim; the client reads body.error
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
        Wan().ping.spawn()
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
        call = Wan().run.spawn(
            prompt=prompt,
            negative_prompt=payload.get("negative_prompt") or "",
            width=int(payload.get("width") or 832),
            height=int(payload.get("height") or 480),
            num_frames=int(payload.get("num_frames") or FRAMES_PER_CLIP),
            fps=int(payload.get("fps") or DEFAULT_FPS),
            num_clips=int(payload.get("num_clips") or 1),
            seed=int(payload.get("seed") or 42),
            video=payload.get("video") or "",
            strength=float(payload.get("strength") or 0.6),
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
