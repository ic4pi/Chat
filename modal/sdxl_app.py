"""
SDXL images on Modal — the `sdxl-nsfw` app.

Serves POST https://ic4pi--sdxl-nsfw-generate.modal.run, consumed by
generateModalSdxlImage() in api/media-generate.js.

    request   {prompt, negative_prompt?, model, width, height}
    response  {image_base64, elapsed_seconds}

`model` is one of the keys in CHECKPOINTS below; the client normalises to
these via MODAL_IMAGE_MODELS and defaults to "lustify".

Deploy:  modal deploy modal/sdxl_app.py

!! RECONSTRUCTED — see modal/README.md before deploying over a working app.
   The checkpoint sources in particular are the least certain part of this
   file; confirm them against the live app first. !!
"""

import base64
import io
import os
import time

import modal

# Both are community SDXL checkpoints distributed as single .safetensors files.
# Override per deploy without editing this file:
#   modal deploy modal/sdxl_app.py  (reads SDXL_LUSTIFY_REPO / SDXL_WAI_REPO)
CHECKPOINTS = {
    "lustify": {
        "repo": os.environ.get("SDXL_LUSTIFY_REPO", "John6666/lustify-sdxl-nsfw-checkpoint-v20-sdxl"),
        "single_file": None,
    },
    "wai-illustrious": {
        "repo": os.environ.get("SDXL_WAI_REPO", "John6666/wai-nsfw-illustrious-sdxl-v110-sdxl"),
        "single_file": None,
    },
}
DEFAULT_MODEL = "lustify"

# Batch ceiling. Four 1024px images fit an L4 comfortably alongside a resident
# SDXL; past that the activations start competing with the weights.
MAX_BATCH = 4

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.6.0",
        "diffusers==0.36.0",
        "transformers==4.51.3",
        "accelerate==1.6.0",
        "safetensors",
        "sentencepiece",
        "pillow",
        "fastapi[standard]",
    )
)

app = modal.App("sdxl-nsfw")
cache = modal.Volume.from_name("sdxl-model-cache", create_if_missing=True)


@app.cls(
    gpu="L4",
    image=image,
    volumes={"/cache": cache},
    scaledown_window=300,
    timeout=1800,
)
class SDXL:
    @modal.enter()
    def load(self):
        import torch
        from diffusers import DPMSolverMultistepScheduler, StableDiffusionXLPipeline

        os.environ["HF_HOME"] = "/cache/hf"
        self._torch = torch
        self._cls = StableDiffusionXLPipeline
        self._sched = DPMSolverMultistepScheduler
        # Checkpoints load lazily and stay cached per container: holding both
        # in VRAM at once would not fit an L4 alongside generation.
        self._loaded: dict = {}

    def _pipe(self, name: str):
        if name in self._loaded:
            return self._loaded[name]

        spec = CHECKPOINTS[name]
        pipe = self._cls.from_pretrained(
            spec["repo"],
            torch_dtype=self._torch.float16,
            variant="fp16",
            use_safetensors=True,
            cache_dir="/cache/hf",
            # The point of self-hosting is that nothing moderates the output.
            safety_checker=None,
            requires_safety_checker=False,
        )
        # DPM++ 2M Karras reaches the same quality in ~20-25 steps that the
        # default scheduler needs 30+ for.
        pipe.scheduler = self._sched.from_config(
            pipe.scheduler.config, use_karras_sigmas=True, algorithm_type="dpmsolver++"
        )

        # Resident on the GPU, NOT offloaded. SDXL in fp16 is ~7GB against the
        # L4's 24GB, so enable_model_cpu_offload() was shuttling weights across
        # PCIe every step to solve a memory problem that does not exist here.
        # Offloading is kept only as an escape hatch for a smaller card.
        if os.environ.get("SDXL_CPU_OFFLOAD") == "1":
            pipe.enable_model_cpu_offload()
        else:
            pipe.to("cuda")

        # Only one checkpoint stays resident; swapping is cheaper than OOM.
        self._loaded.clear()
        self._loaded[name] = pipe
        return pipe

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
        model: str = DEFAULT_MODEL,
        width: int = 1024,
        height: int = 1024,
        seed: int = 42,
        steps: int = 22,  # DPM++ 2M Karras; 30 was for the default scheduler
        guidance_scale: float = 6.0,
        n: int = 1,
        fmt: str = "webp",
    ) -> dict:
        started = time.time()
        name = model if model in CHECKPOINTS else DEFAULT_MODEL
        pipe = self._pipe(name)

        # SDXL is trained at multiples of 64; off-grid sizes produce seams.
        width = max(512, int(round(width / 64)) * 64)
        height = max(512, int(round(height / 64)) * 64)
        n = max(1, min(MAX_BATCH, int(n)))

        # One call with num_images_per_prompt beats N calls: the prompt is
        # encoded once and the UNet runs the batch together, so four images
        # cost far less than four times one. Batch size is what fills the
        # L4 now that the model sits resident instead of being offloaded.
        generator = [
            self._torch.Generator("cpu").manual_seed(seed + i) for i in range(n)
        ]
        images = pipe(
            prompt=prompt,
            negative_prompt=negative_prompt or None,
            width=width,
            height=height,
            num_inference_steps=steps,
            guidance_scale=guidance_scale,
            generator=generator,
            num_images_per_prompt=n,
        ).images

        # WebP by default: a 1024px PNG is ~1.5MB, and a handful of those
        # base64-encoded blows the caller's response budget. WebP at q92 is
        # visually equivalent at a fraction of the size.
        encoded = []
        for img in images:
            buf = io.BytesIO()
            if fmt == "png":
                img.save(buf, format="PNG")
            else:
                img.save(buf, format="WEBP", quality=92, method=4)
            encoded.append(base64.b64encode(buf.getvalue()).decode())

        return {
            # Singular key kept so an older caller keeps working.
            "image_base64": encoded[0],
            "images_base64": encoded,
            "mime_type": "image/png" if fmt == "png" else "image/webp",
            "count": len(encoded),
            "elapsed_seconds": round(time.time() - started, 2),
            "model": name,
            "width": width,
            "height": height,
            "seed": seed,
        }


@app.function(image=image, timeout=1800)
@modal.fastapi_endpoint(method="POST")
def generate(payload: dict) -> dict:
    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        return {"error": "Missing 'prompt'."}

    try:
        return SDXL().run.remote(
            prompt=prompt,
            negative_prompt=payload.get("negative_prompt") or "",
            model=payload.get("model") or DEFAULT_MODEL,
            width=int(payload.get("width") or 1024),
            height=int(payload.get("height") or 1024),
            seed=int(payload.get("seed") or 42),
            n=int(payload.get("n") or 1),
            fmt=str(payload.get("format") or "webp"),
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
        SDXL().ping.spawn()
        return {"warming": True}
    except Exception as exc:
        return {"warming": False, "error": f"{type(exc).__name__}: {exc}"}
