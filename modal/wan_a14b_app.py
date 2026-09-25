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
import random
import re
import os
import time

import modal

MODEL_ID = "Wan-AI/Wan2.2-T2V-A14B-Diffusers"

# Bounds how many extra community LoRAs one request can stack on top of the
# Lightning/NSFW adapters this app already carries. Same cap as sdxl_app.py.
MAX_EXTRA_LORAS = 4

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

# Official Wan-AI checkpoints carry content alignment from training — they
# steer away from explicit prompts instead of generating them (confirmed: a
# direct, explicit prompt came back as two fully-clothed men and a dog on a
# public street). Same problem sdxl_app.py's checkpoints solved by using
# lustify/wai-illustrious instead of stock SDXL. This is that fix for video:
# a community NSFW LoRA, same high/low-noise-per-expert shape as Lightning,
# stacked as a second adapter rather than replacing Lightning.
#
# First attempt (lopi999/Wan2.2-I2V_General-NSFW-LoRA) loaded without error
# but didn't visibly change output — trained against I2V-A14B, not T2V, and
# the delta apparently didn't transfer. This one ships T2V_14B_HIGH/LOW files
# specifically (not just I2V), matching this app's architecture exactly.
NSFW_LORA_REPO = os.environ.get("WAN_A14B_NSFW_LORA_REPO", "lopi999/Wan2.2-DR34ML4Y-AIO_NSFW-LoRA")
NSFW_LORA_HIGH_FILE = os.environ.get("WAN_A14B_NSFW_LORA_HIGH_FILE", "DR34ML4Y_T2V_14B_HIGH_V2.safetensors")
NSFW_LORA_LOW_FILE = os.environ.get("WAN_A14B_NSFW_LORA_LOW_FILE", "DR34ML4Y_T2V_14B_LOW_V2.safetensors")
# The LoRA's own trigger words are specific acts/positions (m15510n4ry,
# bl0wj0b, d0ubl3_bj, c0wg1rl, d0gg1e) rather than one generic on-switch —
# appending a single fixed one would bias every generation toward that one
# act, so this stays unset by default and the prompt itself should include
# whichever trigger word fits, in place of NSFW_LORA_TRIGGER when set.
NSFW_LORA_TRIGGER = os.environ.get("WAN_A14B_NSFW_LORA_TRIGGER", "")

FAST_STEPS = 4
FAST_GUIDANCE = 1.0
FULL_STEPS = 40
FULL_GUIDANCE = 4.0  # A14B's own recommended default, not the 5B app's 5.0

DEFAULT_FPS = 16
FRAMES_PER_CLIP = 81  # ~5s at 16fps, matching the 5B app's convention
# No I2V-A14B pipeline is loaded (see module docstring — a second 56GB model
# would not fit alongside this one on the same 80GB card), so there is no
# frame-to-frame chaining path here. Longer output instead means more frames
# in the one pass: slower and past the model's ~5s training length, so
# coherence is unproven past that, but nothing stops the pipeline from
# accepting it. 321 = 4*80+1, ~20s at 16fps.
MAX_FRAMES = 321

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

        # Stacked alongside Lightning, not instead of it — see NSFW_LORA_REPO
        # comment above. A failure here must not take the working Lightning
        # path down either.
        self.nsfw_available = False
        self.nsfw_lora_error = None if NSFW_LORA_REPO else "no NSFW LoRA configured"
        if NSFW_LORA_REPO:
            try:
                self.pipe.load_lora_weights(
                    NSFW_LORA_REPO,
                    weight_name=NSFW_LORA_HIGH_FILE,
                    adapter_name="nsfw_high",
                    cache_dir="/cache/hf",
                )
                self.pipe.load_lora_weights(
                    NSFW_LORA_REPO,
                    weight_name=NSFW_LORA_LOW_FILE,
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

        # 56GB of experts alone against an 80GB card — offload keeps headroom
        # for activations at 720p instead of cutting it close.
        self.pipe.enable_model_cpu_offload()

        # Extra community LoRAs a caller stacks on top of Lightning/NSFW —
        # see _load_extra_loras.
        self._extra_loras: dict = {}

    def _load_extra_loras(self, requested: list):
        """Load (not yet activate) the caller's requested community LoRA
        stack, on top of whatever Lightning/NSFW adapters this container
        already carries. Returns (names, weights, errors) to fold into
        run()'s own set_adapters() call — this app already needs one call
        combining several adapter groups per request, so loading and
        activating are kept separate here (unlike sdxl_app.py/wan_app.py,
        where nothing else shares the call).

        A14B is two 14B experts (high/low-noise, switched by timestep) —
        this app's own NSFW/Lightning LoRAs both ship matched high/low
        file pairs for exactly that reason. A generic single-file LoRA from
        the Hub is very unlikely to be split the same way, so the default
        here is to load it onto the high-noise expert only, which is where
        the bulk of composition/subject gets decided; a spec can name
        weight_name_low too if it happens to have a matching pair, mirroring
        NSFW_LORA_HIGH_FILE/LOW_FILE above. This is a real assumption, not a
        verified fact — a LoRA that only touches one expert may show up
        weaker than the same weight would on a single-transformer model.
        """
        names, weights, errors = [], [], []
        for i, spec in enumerate((requested or [])[:MAX_EXTRA_LORAS]):
            if not isinstance(spec, dict):
                continue
            repo = str(spec.get("repo") or "").strip()
            if not repo:
                continue
            weight_name = spec.get("weight_name") or None
            weight_name_low = spec.get("weight_name_low") or None
            scale = max(0.0, min(2.0, float(spec.get("scale", 1.0))))
            slug = re.sub(r"[^a-zA-Z0-9]", "_", f"{repo}_{weight_name or ''}")[:50]
            adapter_id = f"extra{i}_{slug}"
            if adapter_id not in self._extra_loras:
                try:
                    self.pipe.load_lora_weights(
                        repo, weight_name=weight_name, adapter_name=adapter_id, cache_dir="/cache/hf",
                    )
                    if weight_name_low:
                        self.pipe.load_lora_weights(
                            repo,
                            weight_name=weight_name_low,
                            adapter_name=f"{adapter_id}_low",
                            load_into_transformer_2=True,
                            cache_dir="/cache/hf",
                        )
                    self._extra_loras[adapter_id] = (repo, weight_name, weight_name_low)
                except Exception as exc:
                    errors.append(f"{repo}{'/' + weight_name if weight_name else ''}: {type(exc).__name__}: {exc}")
                    continue
            names.append(adapter_id)
            weights.append(scale)
            if self._extra_loras.get(adapter_id, (None, None, None))[2]:
                names.append(f"{adapter_id}_low")
                weights.append(scale)
        return names, weights, errors

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
        negative_prompt: str = "",
        width: int = 1280,
        height: int = 720,
        num_frames: int = FRAMES_PER_CLIP,
        fps: int = DEFAULT_FPS,
        seed: int = 42,
        steps: int | None = None,
        guidance_scale: float | None = None,
        polish: bool = True,
        nsfw: bool = True,  # append the NSFW LoRA's trigger word, if it loaded
        # None = use Lightning iff it loaded (old default). Explicit False is
        # the one that matters: set_adapters() at load() fixed the adapter
        # list for the container's whole life, so every request got
        # Lightning's weights merged in regardless of steps/guidance_scale —
        # sending real CFG through a LoRA distilled for CFG-1/4-step is
        # exactly the "distilled model given real CFG produces burnt,
        # oversaturated frames" case wan_app.py's own Lightning comment
        # warns about, AND leaves less headroom for the NSFW LoRA stacked
        # alongside it to actually show up. False detaches Lightning's
        # adapters for this call instead of merely outrunning them with
        # more steps.
        use_lightning: bool | None = None,
        # Binary on/off was the only lever before — a LoRA trained strong
        # can still oversaturate or fight the base model's own coherence at
        # full weight, and the fix for that is turning it down, not off.
        # 1.0 = as trained.
        nsfw_scale: float = 1.0,
        loras: list | None = None,  # [{repo, weight_name?, weight_name_low?, scale?}, ...]
    ) -> dict:
        import torch
        from diffusers.utils import export_to_video

        started = time.time()
        # Wan rejects frame counts that are not 4k+1.
        num_frames = max(5, min(MAX_FRAMES, ((int(num_frames) - 1) // 4) * 4 + 1))
        use_speed = self.fast if use_lightning is None else (use_lightning and self.fast)
        if steps is None:
            steps = FAST_STEPS if use_speed else FULL_STEPS
        if guidance_scale is None:
            guidance_scale = FAST_GUIDANCE if use_speed else FULL_GUIDANCE

        use_nsfw = nsfw and self.nsfw_available
        run_prompt = f"{prompt}, {NSFW_LORA_TRIGGER}" if use_nsfw and NSFW_LORA_TRIGGER else prompt
        nsfw_scale = max(0.0, min(2.0, float(nsfw_scale)))

        # Per-request adapter selection — load() merely made these available,
        # it did not commit every call to using all of them.
        wanted, weights = [], []
        if use_speed:
            wanted += ["lightning_high", "lightning_low"]
            weights += [1.0, 1.0]
        if use_nsfw:
            wanted += ["nsfw_high", "nsfw_low"]
            weights += [nsfw_scale, nsfw_scale]
        extra_names, extra_weights, lora_errors = self._load_extra_loras(loras)
        wanted += extra_names
        weights += extra_weights
        self.pipe.set_adapters(wanted, adapter_weights=weights) if wanted else self.pipe.disable_lora()

        frames = self.pipe(
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
            "loras_applied": extra_names,
            "lora_errors": lora_errors,
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
            seed=int(payload["seed"]) if payload.get("seed") else random.randint(1, 2**31 - 1),
            steps=int(payload["steps"]) if payload.get("steps") else None,
            guidance_scale=(
                float(payload["guidance_scale"]) if payload.get("guidance_scale") else None
            ),
            **({"polish": payload["polish"]} if "polish" in payload else {}),
            **({"nsfw": payload["nsfw"]} if "nsfw" in payload else {}),
            **({"use_lightning": payload["use_lightning"]} if "use_lightning" in payload else {}),
            **({"nsfw_scale": float(payload["nsfw_scale"])} if "nsfw_scale" in payload else {}),
            loras=payload.get("loras") if isinstance(payload.get("loras"), list) else None,
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


# Diagnostic, not a warmup: blocks on the cold start (up to ~a minute) so it
# can hand back whether the NSFW LoRA actually loaded on this container
# (gated repo, renamed weight file, and a shape mismatch all fail silently
# inside load() otherwise, and the only symptom is output that looks like
# the stock, alignment-steered checkpoint). Costs one cold start, no GPU
# generation — call this before spending a real generation trying to tell
# "the LoRA didn't apply" apart from "it applied and this is its output."
@app.function(image=image, timeout=120)
@modal.fastapi_endpoint(method="POST")
def status() -> dict:
    try:
        return WanA14B().ping.remote()
    except Exception as exc:
        import traceback

        return {
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": "".join(traceback.format_exc()).strip()[-3000:],
        }


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
            seed=int(payload["seed"]) if payload.get("seed") else random.randint(1, 2**31 - 1),
            steps=int(payload["steps"]) if payload.get("steps") else None,
            guidance_scale=(
                float(payload["guidance_scale"]) if payload.get("guidance_scale") else None
            ),
            **({"polish": payload["polish"]} if "polish" in payload else {}),
            **({"nsfw": payload["nsfw"]} if "nsfw" in payload else {}),
            **({"use_lightning": payload["use_lightning"]} if "use_lightning" in payload else {}),
            **({"nsfw_scale": float(payload["nsfw_scale"])} if "nsfw_scale" in payload else {}),
            loras=payload.get("loras") if isinstance(payload.get("loras"), list) else None,
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
