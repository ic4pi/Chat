"""
SDXL images on Modal — the `sdxl-nsfw` app.

Serves POST https://ic4pi--sdxl-nsfw-generate.modal.run, consumed by
generateModalSdxlImage() in api/media-generate.js.

    request   {prompt, negative_prompt?, model, width, height}
    response  {image_base64, elapsed_seconds}

`model` is one of the keys in CHECKPOINTS below; the client normalises to
these via MODAL_IMAGE_MODELS and defaults to "lustify".

Deploy:  modal deploy modal/sdxl_app.py

!! RECONSTRUCTED — see modal/README.md before deploying over a working app. !!

The checkpoint ids this file shipped with were guessed and both were wrong —
the Hub answered 401 for each, which surfaced as "model is not cached locally"
at request time. The current pair is confirmed reachable; re-run the deploy
workflow with mode: probe before changing either.
"""

import base64
import io
import os
import time

import modal

# Both are community SDXL checkpoints distributed as single .safetensors files.
# Override per deploy without editing this file:
#   modal deploy modal/sdxl_app.py  (reads SDXL_LUSTIFY_REPO / SDXL_WAI_REPO)
# Both ids here were wrong and had been since this file was written: the Hub
# answers 401 for each, so every image request died in the checkpoint load and
# reported it as "model is not cached locally and an error occurred while
# trying to fetch metadata from the Hub" — which reads like a network fault.
# These two are verified reachable by the deploy workflow's preflight; do not
# change them without re-running it (mode: probe).
CHECKPOINTS = {
    "lustify": {
        "repo": os.environ.get("SDXL_LUSTIFY_REPO", "John6666/lustify-sdxl-nsfwsfw-v2-sdxl"),
        "single_file": None,
    },
    "wai-illustrious": {
        "repo": os.environ.get("SDXL_WAI_REPO", "John6666/wai-nsfw-illustrious-sdxl-v140-sdxl"),
        "single_file": None,
    },
}
# ControlNet for pose. Takes an OpenPose skeleton — a drawn stick figure works
# as well as one detected from a photo, since the model only ever sees the
# skeleton.
POSE_CONTROLNET = os.environ.get(
    "SDXL_POSE_CONTROLNET", "xinsir/controlnet-openpose-sdxl-1.0"
)

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
        "controlnet-aux==0.0.9",
        "fastapi[standard]",
    )
)

# Deploy alongside the existing app instead of over it:
#   MODAL_APP_NAME=sdxl-nsfw-v2 modal deploy modal/sdxl_app.py
# The site picks the target with MODAL_*_ENDPOINT, so switching back is
# deleting an env var rather than redeploying.
app = modal.App(os.environ.get("MODAL_APP_NAME", "sdxl-nsfw"))
cache = modal.Volume.from_name("sdxl-model-cache", create_if_missing=True)

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


def _load_pipeline(cls, repo: str, torch_dtype, **kwargs):
    """from_pretrained that survives a repo with no fp16 variant.

    Community SDXL checkpoints (the John6666 conversions among them) ship one
    set of plain *.safetensors — no *.fp16.safetensors. Asking for
    variant="fp16" makes diffusers look for files that were never published,
    and the resulting Hub miss surfaces as "model is not cached locally and an
    error occurred while trying to fetch metadata from the Hub", which reads
    like a network fault and is not one. Try the variant, fall back to plain.
    """
    try:
        return cls.from_pretrained(
            repo, torch_dtype=torch_dtype, variant="fp16", **kwargs
        )
    except Exception:
        return cls.from_pretrained(repo, torch_dtype=torch_dtype, **kwargs)


def download_weights():
    """Populate the cache volume at deploy time.

    Without this the first request to a cold container is also the first ~7GB
    download from the Hub, inside the request path — so a slow or rate-limited
    Hub does not mean "slow image", it means the request fails with an OSError
    the site can only report verbatim. Deploy pays that cost once instead.

    snapshot_download rather than from_pretrained: this runs on a CPU builder
    and only needs the files on disk, not a pipeline instantiated in RAM.
    """
    from huggingface_hub import snapshot_download

    # Weights ship as .safetensors; the .bin/.ckpt copies are the same tensors
    # again and would double both the download and the volume.
    dupes = ["*.bin", "*.ckpt", "*.msgpack", "*.onnx", "*.h5"]

    for name, spec in CHECKPOINTS.items():
        print(f"caching {name}: {spec['repo']}", flush=True)
        snapshot_download(spec["repo"], cache_dir="/cache/hf", ignore_patterns=dupes)

    print(f"caching controlnet: {POSE_CONTROLNET}", flush=True)
    snapshot_download(POSE_CONTROLNET, cache_dir="/cache/hf", ignore_patterns=dupes)

    try:
        # The OpenPose annotator publishes .pth only — no ignore list here.
        print("caching openpose annotator", flush=True)
        snapshot_download("lllyasviel/Annotators", cache_dir="/cache/hf")
    except Exception as exc:  # pose detection is optional, the rest is not
        print(f"openpose annotator skipped: {exc}", flush=True)

    cache.commit()
    print("weights cached", flush=True)


# Runs during `modal deploy`, writing straight into the volume the serving
# class mounts, so a cold container finds the weights already on disk.
image = image.env({"HF_HOME": "/cache/hf"}).run_function(
    download_weights, volumes={"/cache": cache}, secrets=hf_secret, timeout=3600
)


def _decode_image(data: str):
    """Accept a bare base64 string or a full data: URL."""
    from PIL import Image

    if not data:
        return None
    if data.startswith("data:"):
        data = data.split(",", 1)[-1]
    return Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB")


def _expand_canvas(img, left: int, right: int, top: int, bottom: int):
    """Place the source on a larger canvas and mask everything that is new.

    Inpainting fills white. The source is copied onto the canvas rather than
    left blank so the model has real pixels to match colour and lighting
    against; edge-replicated padding under the mask beats flat grey, which
    tends to bleed a grey halo into the fill.
    """
    from PIL import Image, ImageFilter

    w, h = img.size
    nw, nh = w + left + right, h + top + bottom

    canvas = Image.new("RGB", (nw, nh))
    # Stretch the border outward as a base coat, then paste the real image.
    if left or right or top or bottom:
        canvas.paste(img.resize((nw, nh), Image.LANCZOS), (0, 0))
        canvas = canvas.filter(ImageFilter.GaussianBlur(24))
    canvas.paste(img, (left, top))

    mask = Image.new("L", (nw, nh), 255)
    mask.paste(Image.new("L", (w, h), 0), (left, top))
    # Softening the boundary stops a hard seam where new meets original.
    mask = mask.filter(ImageFilter.GaussianBlur(8))

    return canvas, mask


@app.cls(
    gpu="L4",
    image=image,
    volumes={"/cache": cache},
    secrets=hf_secret,
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
        self._siblings: dict = {}
        self._cnet = None
        self._pose_det = None

    def _sibling(self, name: str, kind: str):
        """An img2img / inpaint / controlnet pipeline over the same weights.

        Built from the base pipeline's `.components` rather than loaded again,
        so a second mode costs no extra VRAM and no extra cold start.
        """
        key = f"{name}:{kind}"
        if key in self._siblings:
            return self._siblings[key]

        base = self._pipe(name)
        if kind == "img2img":
            from diffusers import StableDiffusionXLImg2ImgPipeline

            pipe = StableDiffusionXLImg2ImgPipeline(**base.components)
        elif kind == "inpaint":
            from diffusers import StableDiffusionXLInpaintPipeline

            pipe = StableDiffusionXLInpaintPipeline(**base.components)
        elif kind == "pose":
            from diffusers import StableDiffusionXLControlNetPipeline

            pipe = StableDiffusionXLControlNetPipeline(
                **base.components, controlnet=self._controlnet()
            )
        else:
            raise ValueError(f"unknown pipeline kind: {kind}")

        # Siblings share the base's weights, which are already on the GPU.
        self._siblings.clear()
        self._siblings[key] = pipe
        return pipe

    def _controlnet(self):
        if self._cnet is None:
            from diffusers import ControlNetModel

            self._cnet = ControlNetModel.from_pretrained(
                POSE_CONTROLNET,
                torch_dtype=self._torch.float16,
                cache_dir="/cache/hf",
            ).to("cuda")
        return self._cnet

    def _pose_from_photo(self, img):
        """Extract an OpenPose skeleton. Only needed when the caller sends a
        photo rather than a skeleton they drew themselves."""
        if self._pose_det is None:
            from controlnet_aux import OpenposeDetector

            # No cache_dir meant this re-downloaded on every cold container.
            self._pose_det = OpenposeDetector.from_pretrained(
                "lllyasviel/Annotators", cache_dir="/cache/hf"
            )
        return self._pose_det(img, hand_and_face=True)

    def _pipe(self, name: str):
        if name in self._loaded:
            return self._loaded[name]

        spec = CHECKPOINTS[name]
        pipe = _load_pipeline(
            self._cls,
            spec["repo"],
            self._torch.float16,
            use_safetensors=True,
            cache_dir="/cache/hf",
            # The point of self-hosting is that nothing moderates the output.
            safety_checker=None,
            requires_safety_checker=False,
        )
        # DPM++ 2M Karras reaches the same quality in ~20-25 steps that the
        # default scheduler needs 30+ for — but only when the checkpoint's own
        # scheduler config is compatible with the Karras sigma schedule. On
        # these community conversions it is not: generation dies with
        # "IndexError: index 23 is out of bounds for dimension 0 with size 23"
        # as the solver steps past the end of its own sigma array. A sampler
        # optimisation is not worth a checkpoint that cannot render at all, so
        # the model's own scheduler is the default and the swap is opt-in.
        if os.environ.get("SDXL_KARRAS") == "1":
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
        # Siblings wrap the outgoing weights, so they go too.
        self._loaded.clear()
        self._siblings.clear()
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
        steps: int = 30,  # the checkpoint's own scheduler; 22 was for DPM++
        guidance_scale: float = 6.0,
        n: int = 1,
        fmt: str = "webp",
        mode: str = "text",
        image: str = "",
        strength: float = 0.35,
        expand: dict | None = None,
        control_scale: float = 0.8,
        detect_pose: bool = True,
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
        common = dict(
            prompt=prompt,
            negative_prompt=negative_prompt or None,
            num_inference_steps=steps,
            guidance_scale=guidance_scale,
            generator=generator,
            num_images_per_prompt=n,
        )
        source = _decode_image(image)
        if mode != "text" and source is None:
            raise ValueError(f"mode '{mode}' needs an 'image'.")

        if mode == "img2img":
            # Low strength keeps the original and restyles it; high strength
            # uses it as loose composition. The pipeline takes its size from
            # the source, so width/height are not passed.
            images = self._sibling(name, "img2img")(
                image=source, strength=max(0.05, min(1.0, float(strength))), **common
            ).images

        elif mode in ("expand", "outpaint"):
            e = expand or {}
            canvas, mask = _expand_canvas(
                source,
                max(0, int(e.get("left", 0))),
                max(0, int(e.get("right", 0))),
                max(0, int(e.get("top", 0))),
                max(0, int(e.get("bottom", 0))),
            )
            cw, ch = canvas.size
            images = self._sibling(name, "inpaint")(
                image=canvas,
                mask_image=mask,
                width=max(512, int(round(cw / 8)) * 8),
                height=max(512, int(round(ch / 8)) * 8),
                # Near-1.0: the masked region is new canvas, not something to
                # preserve. Lower values leave the blurred base coat showing.
                strength=0.99,
                **common,
            ).images

        elif mode == "pose":
            # A skeleton the user drew is used as-is; a photo is converted.
            control = self._pose_from_photo(source) if detect_pose else source
            control = control.resize((width, height))
            images = self._sibling(name, "pose")(
                image=control,
                width=width,
                height=height,
                controlnet_conditioning_scale=max(0.0, min(2.0, float(control_scale))),
                **common,
            ).images

        else:
            images = pipe(width=width, height=height, **common).images

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
            "mode": mode,
            "width": images[0].width,
            "height": images[0].height,
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
            steps=int(payload.get("steps") or 30),
            n=int(payload.get("n") or 1),
            fmt=str(payload.get("format") or "webp"),
            mode=str(payload.get("mode") or "text"),
            image=payload.get("image") or "",
            strength=float(payload.get("strength") or 0.35),
            expand=payload.get("expand"),
            control_scale=float(payload.get("control_scale") or 0.8),
            detect_pose=bool(payload.get("detect_pose", True)),
        )
    except Exception as exc:
        # The bare message is not enough to place a failure inside the
        # pipeline: "IndexError: index 9 is out of bounds" says nothing about
        # which call raised it, and the traceback only exists in Modal's own
        # logs, which the caller cannot read. Send the last frames back.
        import traceback

        return {
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": "".join(traceback.format_exc()).strip()[-3000:],
        }


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
