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
        "torch==2.6.0",
        "diffusers==0.36.0",
        "transformers==4.51.3",
        "accelerate==1.6.0",
        "safetensors",
        "sentencepiece",
        "ftfy",
        "imageio",
        "imageio-ffmpeg",
        "pillow",
        "fastapi[standard]",
    )
)

app = modal.App("wan-video")
cache = modal.Volume.from_name("wan-model-cache", create_if_missing=True)


@app.cls(
    gpu="L4",
    image=image,
    volumes={"/cache": cache},
    # Weights are ~10GB off a cold volume; a short window makes every request
    # after an idle gap pay that again. 5 min keeps a working session warm
    # while still scaling to zero, which is the whole point of this being here
    # rather than on an always-on box.
    scaledown_window=300,
    timeout=3600,
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
        # TI2V-5B carries no CLIP vision tower, so the i2v pipeline is built off
        # the t2v components rather than loaded a second time — same weights in
        # VRAM, both entry points available for the chain.
        self.i2v = WanImageToVideoPipeline(
            tokenizer=self.t2v.tokenizer,
            text_encoder=self.t2v.text_encoder,
            vae=self.t2v.vae,
            scheduler=self.t2v.scheduler,
            transformer=self.t2v.transformer,
        )
        # Loaded onto the shared transformer, so both pipelines get it.
        # A failure here must not take generation down — it falls back to full
        # steps, which is slow but correct, and says so in the response.
        self.fast = False
        if LIGHTNING_LORA_REPO:
            try:
                kwargs = {"cache_dir": "/cache/hf"}
                if LIGHTNING_LORA_WEIGHT:
                    kwargs["weight_name"] = LIGHTNING_LORA_WEIGHT
                self.t2v.load_lora_weights(LIGHTNING_LORA_REPO, **kwargs)
                self.t2v.fuse_lora()
                self.fast = True
            except Exception as exc:
                print(f"Lightning LoRA unavailable ({exc!r}); using full steps.")

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
        width: int = 832,
        height: int = 480,
        num_frames: int = FRAMES_PER_CLIP,
        fps: int = DEFAULT_FPS,
        num_clips: int = 1,
        seed: int = 42,
        steps: int | None = None,
        guidance_scale: float | None = None,
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
