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
        from diffusers import StableDiffusionXLPipeline

        os.environ["HF_HOME"] = "/cache/hf"
        self._torch = torch
        self._cls = StableDiffusionXLPipeline
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
        pipe.enable_model_cpu_offload()
        # Only one checkpoint stays resident; swapping is cheaper than OOM.
        self._loaded.clear()
        self._loaded[name] = pipe
        return pipe

    @modal.method()
    def run(
        self,
        prompt: str,
        negative_prompt: str = "",
        model: str = DEFAULT_MODEL,
        width: int = 1024,
        height: int = 1024,
        seed: int = 42,
        steps: int = 30,
        guidance_scale: float = 6.0,
    ) -> dict:
        started = time.time()
        name = model if model in CHECKPOINTS else DEFAULT_MODEL
        pipe = self._pipe(name)

        # SDXL is trained at multiples of 64; off-grid sizes produce seams.
        width = max(512, int(round(width / 64)) * 64)
        height = max(512, int(round(height / 64)) * 64)

        generator = self._torch.Generator("cpu").manual_seed(seed)
        result = pipe(
            prompt=prompt,
            negative_prompt=negative_prompt or None,
            width=width,
            height=height,
            num_inference_steps=steps,
            guidance_scale=guidance_scale,
            generator=generator,
        ).images[0]

        buf = io.BytesIO()
        result.save(buf, format="PNG")

        return {
            "image_base64": base64.b64encode(buf.getvalue()).decode(),
            "elapsed_seconds": round(time.time() - started, 2),
            "model": name,
            "width": width,
            "height": height,
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
        )
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}
