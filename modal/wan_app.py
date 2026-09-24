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
import random
import io
import os
import subprocess
import tempfile
import time

import fastapi
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
# OFF by default: lightx2v/Wan2.2-Lightning ships LoRA weights only for the
# Wan 2.2 A14B variants (T2V-A14B, I2V-A14B — hidden dim 5120). This app runs
# TI2V-5B (hidden dim 3072), and the repo has no TI2V-5B build at all, so
# loading it fails on every block with a shape mismatch:
#   size mismatch for blocks.0.attn1.to_q.lora_A.default_0.weight: copying a
#   param with shape [64, 5120] ... the shape in current model is [64, 3072]
# The load failure is caught and falls back to full steps (see `fast` in the
# response), so this was never silently broken — but it paid a download and a
# guaranteed-failing load on every cold container for a feature that could
# never activate. Point WAN_LIGHTNING_LORA_REPO at a real TI2V-5B distillation
# if one appears, or switch MODEL_ID to an A14B variant to use this one.
LIGHTNING_LORA_REPO = os.environ.get("WAN_LIGHTNING_LORA_REPO", "")
LIGHTNING_LORA_WEIGHT = os.environ.get("WAN_LIGHTNING_LORA_WEIGHT", "")

FAST_STEPS = 4
FAST_GUIDANCE = 1.0
FULL_STEPS = 40      # measured: 832x480, ~6m20s for one 5s clip
FULL_GUIDANCE = 5.0

# Optional shared-secret gate on every web endpoint below. Unset by default —
# same "unset = open, single-owner use" convention as VIDEO_ACCESS_KEYS in
# api/media-generate.js. Set this (and MODAL_SHARED_SECRET in Vercel's env,
# same name) to require the header on every call; leave both unset and the
# app stays exactly as open as it is today.
SHARED_SECRET = os.environ.get("MODAL_SHARED_SECRET", "")


def _check_secret(x_modal_secret: str) -> None:
    if SHARED_SECRET and x_modal_secret != SHARED_SECRET:
        raise fastapi.HTTPException(status_code=401, detail="Invalid or missing X-Modal-Secret header.")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "av",
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

# Deploy alongside the existing app instead of over it:
#   MODAL_APP_NAME=wan-video-v2 modal deploy modal/wan_app.py
# The site picks the target with MODAL_*_ENDPOINT, so switching back is
# deleting an env var rather than redeploying.
app = modal.App(os.environ.get("MODAL_APP_NAME", "wan-video"))
cache = modal.Volume.from_name("wan-model-cache", create_if_missing=True)


def _decode_image(data: str):
    """Accept a bare base64 string or a full data: URL."""
    from PIL import Image

    if not data:
        return None
    if data.startswith("data:"):
        data = data.split(",", 1)[-1]
    return Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB")


def _wan_frames(n: int) -> int:
    """Wan's temporal patching needs 4k+1 frames; anything else is rejected."""
    return max(5, ((int(n) - 1) // 4) * 4 + 1)


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


def _export_polished(frames, path: str, fps: int, upscale: int = 2) -> int:
    """Export frames to mp4, then run the clip through motion-compensated
    frame interpolation and a lanczos upscale before returning it.

    This is the actual gap between a small fast model's native output and
    what commercial generators (Runway, Pika, Luma) look like: a chunk of
    their polish is a post pass on top of the raw generation, not just a
    bigger model. ffmpeg does both here in one pass — no extra model weights,
    no extra GPU memory, nothing that can break the way an ML upscaler's
    dependency chain can. If the pass fails for any reason, the raw clip
    ships instead of failing the whole request.
    """
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
    gpu="A10G",
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
        # TI2V-5B carries no CLIP vision tower, so the i2v pipeline shares the
        # t2v components rather than loading a second copy — same weights in
        # VRAM, both entry points available for the chain.
        #
        # Built with from_pretrained, not by constructing the class directly.
        # WanImageToVideoPipeline.__init__ defaults expand_timesteps=False;
        # this repo's model_index.json sets it True (TI2V-5B conditions image
        # frames by masking the input timesteps, not by concatenating a masked
        # latent onto the channel axis the way Wan 2.1's i2v pipeline does),
        # and only from_pretrained reads that. Constructed directly, the i2v
        # pipeline took the Wan 2.1 branch and handed the transformer 100
        # channels (48 latent + 48 masked-latent + 4 mask) where TI2V-5B's
        # conv-in takes 48:
        #   RuntimeError: Given groups=1, weight of size [3072, 48, 1, 2, 2],
        #   expected input[1, 100, 21, 30, 52] to have 48 channels, but got 100
        # Clip one is text-to-video and never touches this pipeline, so it
        # always rendered fine; every clip after it seeds from the previous
        # frame through i2v, so any multi-clip request died on clip two with
        # the first clip's GPU time already spent.
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
    def generate(
        self,
        prompt: str,
        negative_prompt: str = "",
        height: int = 480,
        width: int = 832,
        num_frames: int = FRAMES_PER_CLIP,
        fps: int = DEFAULT_FPS,
        guidance_scale: float = FULL_GUIDANCE,
    ) -> str:
        """Minimal single-clip text-to-video entry point: one call into
        self.t2v, no clip-chaining/i2v/restyle/Lightning branching that run()
        does. Kept separate so the simple contract can't be perturbed by
        run()'s other modes. Returns a base64-encoded mp4."""
        import torch
        from diffusers.utils import export_to_video

        frames = self.t2v(
            prompt=prompt,
            negative_prompt=negative_prompt or None,
            height=height,
            width=width,
            num_frames=num_frames,
            num_inference_steps=FULL_STEPS,
            guidance_scale=guidance_scale,
            generator=torch.Generator("cpu").manual_seed(random.randint(1, 2**31 - 1)),
            output_type="pil",
        ).frames[0]

        path = "/tmp/out_t2v.mp4"
        export_to_video(frames, path, fps=fps)
        with open(path, "rb") as fh:
            return base64.b64encode(fh.read()).decode()

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
        image: str = "",     # start the clip from this frame (image-to-video)
        keyframes: list | None = None,  # [{image, frame}] — see the block below
        polish: bool = True,  # ffmpeg interpolation + upscale pass; see _export_polished
        prompts: list | None = None,  # per-clip prompts for a continuous scene
    ) -> dict:
        import torch
        from diffusers.utils import export_to_video

        started = time.time()
        # Re-clamped here, not just client-side: the endpoint is reachable
        # directly and a 20-clip request would run until the timeout.
        shot_prompts = []
        if prompts:
            shot_prompts = [str(p).strip() for p in prompts if str(p or "").strip()]
        if shot_prompts:
            num_clips = len(shot_prompts)
        num_clips = max(1, min(MAX_CLIPS, int(num_clips)))
        if not shot_prompts:
            shot_prompts = [prompt] * num_clips

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
            out_fps = _export_polished(styled, path, fps) if polish else fps
            if not polish:
                export_to_video(styled, path, fps=fps)
            with open(path, "rb") as fh:
                video_b64 = base64.b64encode(fh.read()).decode()
            return {
                "video_base64": video_b64,
                "elapsed_seconds": round(time.time() - started, 2),
                "num_clips": 1,
                "num_frames": len(styled),
                "fps": out_fps,
                "mode": "video2video",
                "fast": self.fast,
                "steps": steps,
                "polished": polish,
            }

        # Timeline keyframes. TI2V-5B has no conditioning pipeline that pins an
        # image to an arbitrary frame index the way LTXConditionPipeline does —
        # VACE is a different checkpoint family and there is no TI2V-5B build of
        # it. What this model does have is i2v, so a keyframe starts a segment
        # rather than being interpolated toward: each image appears at its own
        # mark and the model invents motion forward from it until the next one.
        # That means a cut at every mark, not a morph between them, which is the
        # honest limit of these weights rather than something more code fixes.
        if keyframes:
            marks = []
            for kf in keyframes[:8]:
                img = _decode_image(kf.get("image"))
                if img is None:
                    continue
                marks.append(
                    (max(0, int(kf.get("frame", 0))), img.resize((width, height)))
                )
            if not marks:
                raise ValueError("keyframes were supplied but none carried an image.")
            marks.sort(key=lambda m: m[0])

            frames = []
            for i, (start, img) in enumerate(marks):
                # A segment runs to the next mark. The last mark only gets a
                # full extra clip when it's the ONLY mark (a lone keyframe
                # used as a start image, which has nothing to run toward but
                # forward). With more than one mark, the last one is meant as
                # the video's end — pinned there by the caller (e.g. the
                # "start -> end stills" span) — so it gets just enough frames
                # to land on it instead of continuing a whole new ~5s clip
                # past the point the caller asked the video to stop.
                if i + 1 < len(marks):
                    end = marks[i + 1][0]
                elif len(marks) == 1:
                    end = start + num_frames
                else:
                    end = start + 5
                seg_frames = _wan_frames(max(5, end - start))
                out = self.i2v(
                    image=img,
                    prompt=prompt,
                    negative_prompt=negative_prompt or None,
                    height=height,
                    width=width,
                    num_frames=seg_frames,
                    num_inference_steps=steps,
                    guidance_scale=guidance_scale,
                    generator=torch.Generator("cpu").manual_seed(seed + i),
                    output_type="pil",
                ).frames[0]
                frames.extend(out)

            path = "/tmp/out.mp4"
            out_fps = _export_polished(frames, path, fps) if polish else fps
            if not polish:
                export_to_video(frames, path, fps=fps)
            with open(path, "rb") as fh:
                video_b64 = base64.b64encode(fh.read()).decode()
            return {
                "video_base64": video_b64,
                "elapsed_seconds": round(time.time() - started, 2),
                "num_clips": len(marks),
                "num_frames": len(frames),
                "fps": out_fps,
                "mode": "keyframes",
                "keyframe_count": len(marks),
                "fast": self.fast,
                "steps": steps,
                "polished": polish,
            }

        frames: list = []
        # A supplied start image makes clip 0 take the i2v branch below instead
        # of t2v, which is the whole of "start the video from this picture".
        seed_frame = _decode_image(image)
        if seed_frame is not None:
            seed_frame = seed_frame.resize((width, height))

        for clip in range(num_clips):
            generator = torch.Generator("cpu").manual_seed(seed + clip)
            common = dict(
                prompt=shot_prompts[clip] if clip < len(shot_prompts) else prompt,
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
        out_fps = _export_polished(frames, path, fps) if polish else fps
        if not polish:
            export_to_video(frames, path, fps=fps)
        with open(path, "rb") as fh:
            video_b64 = base64.b64encode(fh.read()).decode()

        return {
            "video_base64": video_b64,
            "elapsed_seconds": round(time.time() - started, 2),
            "num_clips": num_clips,
            "num_frames": len(frames),
            "fps": out_fps,
            "fast": self.fast,
            "steps": steps,
            "polished": polish,
        }


@app.function(image=image, timeout=3600)
@modal.fastapi_endpoint(method="POST")
def generate(
    payload: dict,
    x_modal_secret: str = fastapi.Header(default="", alias="X-Modal-Secret"),
) -> dict:
    """Thin CPU front door. Named `generate` because the deployed URL that
    api/media-generate.js targets is ic4pi--wan-video-generate.modal.run."""
    _check_secret(x_modal_secret)
    prompt = (payload.get("prompt") or "").strip()
    prompts = payload.get("prompts") if isinstance(payload.get("prompts"), list) else None
    if not prompt and not (prompts and any(str(p or "").strip() for p in prompts)):
        return {"error": "Missing 'prompt'."}

    try:
        return Wan().run.remote(
            prompt=prompt or (str(prompts[0]).strip() if prompts else ""),
            negative_prompt=payload.get("negative_prompt") or "",
            width=int(payload.get("width") or 832),
            height=int(payload.get("height") or 480),
            num_frames=int(payload.get("num_frames") or FRAMES_PER_CLIP),
            fps=int(payload.get("fps") or DEFAULT_FPS),
            num_clips=int(payload.get("num_clips") or 1),
            seed=int(payload["seed"]) if payload.get("seed") else random.randint(1, 2**31 - 1),
            video=payload.get("video") or "",
            strength=float(payload.get("strength") or 0.6),
            image=payload.get("image") or "",
            keyframes=payload.get("keyframes"),
            prompts=prompts,
            **({"polish": payload["polish"]} if "polish" in payload else {}),
        )
    except Exception as exc:  # surfaced verbatim; the client reads body.error
        return {"error": f"{type(exc).__name__}: {exc}"}


@app.function(image=image, timeout=60)
@modal.fastapi_endpoint(method="POST")
def warm(
    x_modal_secret: str = fastapi.Header(default="", alias="X-Modal-Secret"),
) -> dict:
    """Kick a container into existence so @modal.enter() loads the weights.

    The browser calls this the moment someone focuses the prompt box, which
    buys ~60s of cold start back against time they were going to spend typing
    anyway. spawn() rather than remote() so it returns immediately instead of
    blocking the page for the whole load."""
    _check_secret(x_modal_secret)
    try:
        Wan().ping.spawn()
        return {"warming": True}
    except Exception as exc:
        return {"warming": False, "error": f"{type(exc).__name__}: {exc}"}


@app.function(image=image, timeout=3600)
@modal.fastapi_endpoint(method="POST")
def t2v(
    payload: dict,
    x_modal_secret: str = fastapi.Header(default="", alias="X-Modal-Secret"),
) -> dict:
    """Minimal text-to-video front door for Wan().generate() — single clip,
    fixed shape (prompt, negative_prompt, height, width, num_frames, fps,
    guidance_scale), no clip-chaining/i2v/restyle. URL:
    ic4pi--wan-video-t2v.modal.run. Response: {video_base64}."""
    _check_secret(x_modal_secret)
    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        return {"error": "Missing 'prompt'."}

    try:
        video_b64 = Wan().generate.remote(
            prompt=prompt,
            negative_prompt=payload.get("negative_prompt") or "",
            height=int(payload.get("height") or 480),
            width=int(payload.get("width") or 832),
            num_frames=int(payload.get("num_frames") or FRAMES_PER_CLIP),
            fps=int(payload.get("fps") or DEFAULT_FPS),
            guidance_scale=float(payload.get("guidance_scale") or FULL_GUIDANCE),
        )
        return {"video_base64": video_b64}
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


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
def submit(
    payload: dict,
    x_modal_secret: str = fastapi.Header(default="", alias="X-Modal-Secret"),
) -> dict:
    """Start a generation and return immediately with its job id."""
    _check_secret(x_modal_secret)
    prompt = (payload.get("prompt") or "").strip()
    prompts = payload.get("prompts") if isinstance(payload.get("prompts"), list) else None
    if not prompt and not (prompts and any(str(p or "").strip() for p in prompts)):
        return {"error": "Missing 'prompt'."}

    try:
        call = Wan().run.spawn(
            prompt=prompt or (str(prompts[0]).strip() if prompts else ""),
            negative_prompt=payload.get("negative_prompt") or "",
            width=int(payload.get("width") or 832),
            height=int(payload.get("height") or 480),
            num_frames=int(payload.get("num_frames") or FRAMES_PER_CLIP),
            fps=int(payload.get("fps") or DEFAULT_FPS),
            num_clips=int(payload.get("num_clips") or 1),
            seed=int(payload["seed"]) if payload.get("seed") else random.randint(1, 2**31 - 1),
            video=payload.get("video") or "",
            strength=float(payload.get("strength") or 0.6),
            image=payload.get("image") or "",
            keyframes=payload.get("keyframes"),
            prompts=prompts,
            **({"polish": payload["polish"]} if "polish" in payload else {}),
        )
        return {"job_id": call.object_id, "status": "running"}
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


@app.function(image=image, timeout=60)
@modal.fastapi_endpoint(method="POST")
def result(
    payload: dict,
    x_modal_secret: str = fastapi.Header(default="", alias="X-Modal-Secret"),
) -> dict:
    """Poll a job. Returns status "running" until the clip is ready.

    timeout=0 makes this a non-blocking check: Modal raises rather than
    holding the connection open, which is the whole point — a polling request
    that blocked would just move the timeout problem instead of solving it."""
    _check_secret(x_modal_secret)
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
