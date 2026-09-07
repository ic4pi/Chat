"""
Structural check for the three Modal apps — run without Modal, a GPU, or a
Hub connection: `python3 modal/check_apps.py`.

It imports each app module against a stub `modal` package and asserts the
things that have actually broken in production:

  * weights are pre-downloaded at deploy time, into the volume the serving
    class mounts (a cold container must never download inside a request)
  * the serving class and the endpoints use the image that download ran on
  * the SDXL loader survives a checkpoint published with no fp16 variant
  * every app still exposes its generate/warm endpoints
"""

import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))

# `python3 modal/check_apps.py --repos` prints every Hugging Face repo id the
# three apps pull, so the deploy workflow can preflight them from one place
# instead of a hand-kept copy that drifts.
PRINT_REPOS = "--repos" in sys.argv

failures = []
checks = 0


def check(cond, label, detail=""):
    global checks
    checks += 1
    if PRINT_REPOS:
        if not cond:
            failures.append(label)
        return
    if cond:
        print(f"check-modal-apps: ok — {label}")
    else:
        failures.append(label)
        print(f"check-modal-apps: FAIL — {label}" + (f"\n    {detail}" if detail else ""))


# ── stub `modal` ────────────────────────────────────────────────────────────

class StubImage:
    def __init__(self):
        self.env_vars = {}
        self.run_functions = []

    def pip_install(self, *a, **k):
        return self

    def apt_install(self, *a, **k):
        return self

    def env(self, mapping):
        self.env_vars.update(mapping)
        return self

    def run_function(self, fn, **kwargs):
        self.run_functions.append((fn, kwargs))
        return self


class StubVolume:
    def __init__(self, name):
        self.name = name

    @staticmethod
    def from_name(name, **k):
        return StubVolume(name)

    def commit(self):
        pass


class StubSecret:
    def __init__(self, name):
        self.name = name

    @staticmethod
    def from_name(name, **k):
        return StubSecret(name)


class StubApp:
    def __init__(self, name):
        self.name = name
        self.classes = {}
        self.functions = {}

    def cls(self, **kwargs):
        def deco(target):
            self.classes[target.__name__] = (target, kwargs)
            return target
        return deco

    def function(self, **kwargs):
        def deco(target):
            self.functions[target.__name__] = (target, kwargs)
            return target
        return deco


def _passthrough(*a, **k):
    def deco(target):
        return target
    return deco


def make_modal_stub():
    m = types.ModuleType("modal")
    m.Image = types.SimpleNamespace(debian_slim=lambda **k: StubImage())
    m.Volume = StubVolume
    m.Secret = StubSecret
    m.App = StubApp
    m.method = _passthrough
    m.enter = _passthrough
    m.fastapi_endpoint = _passthrough
    m.web_endpoint = _passthrough
    m.asgi_app = _passthrough
    return m


def load(filename):
    sys.modules["modal"] = make_modal_stub()
    path = os.path.join(HERE, filename)
    spec = importlib.util.spec_from_file_location(filename[:-3] + "_probe", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── per-app structure ───────────────────────────────────────────────────────

EXPECTED = {
    "sdxl_app.py": ("sdxl-nsfw", "SDXL", "sdxl-model-cache", {"generate", "warm"}),
    "ltx_app.py":  ("ltx-video", "LTX",  "ltx-model-cache",  {"generate", "warm"}),
    "wan_app.py":  ("wan-video", "Wan",  "wan-model-cache",  {"generate", "warm"}),
}

modules = {}
for filename, (app_name, cls_name, vol_name, endpoints) in EXPECTED.items():
    mod = load(filename)
    modules[filename] = mod
    app = mod.app

    check(app.name == app_name, f"{filename}: app name is {app_name}", app.name)
    check(cls_name in app.classes, f"{filename}: serving class {cls_name} registered")
    check(
        endpoints <= set(app.functions),
        f"{filename}: exposes {sorted(endpoints)}",
        f"has {sorted(app.functions)}",
    )

    img = mod.image
    fns = [f.__name__ for f, _ in img.run_functions]
    check(
        "download_weights" in fns,
        f"{filename}: weights are downloaded at deploy time, not per request",
        f"run_function hooks: {fns}",
    )

    dl_kwargs = next((k for f, k in img.run_functions if f.__name__ == "download_weights"), {})
    mounted = {v.name if isinstance(v, StubVolume) else v for v in dl_kwargs.get("volumes", {}).values()}
    check(
        vol_name in mounted,
        f"{filename}: the download writes into {vol_name}",
        f"mounted: {mounted}",
    )

    cls_kwargs = app.classes[cls_name][1]
    serve_vols = {v.name if isinstance(v, StubVolume) else v for v in cls_kwargs.get("volumes", {}).values()}
    check(
        serve_vols == mounted,
        f"{filename}: the serving class reads the same volume the download filled",
        f"serving: {serve_vols} vs download: {mounted}",
    )
    check(
        cls_kwargs.get("image") is img,
        f"{filename}: the serving class uses the image the download ran on",
    )
    check(
        img.env_vars.get("HF_HOME") == "/cache/hf",
        f"{filename}: HF_HOME points at the volume",
        str(img.env_vars),
    )
    # An unset MODAL_HF_SECRET must not smuggle in a secret name that fails deploy.
    check(
        mod.hf_secret == [],
        f"{filename}: no Hub secret required unless MODAL_HF_SECRET is set",
        str(mod.hf_secret),
    )


# ── the video effect paths the site actually calls ──────────────────────────
# Wan restyle sends video+strength; LTX keyframes sends a keyframes list. A
# renamed parameter here is silent: FastAPI hands the endpoint a plain dict,
# so an unread key is dropped and the effect just does not happen.

import inspect

EFFECTS = {
    "wan_app.py": ("Wan", ["video", "strength"], "restyle"),
    "ltx_app.py": ("LTX", ["keyframes"], "keyframes"),
}

for filename, (cls_name, params, effect) in EFFECTS.items():
    mod = modules[filename]
    run = mod.app.classes[cls_name][0].run
    accepted = inspect.signature(run).parameters
    for param in params:
        check(
            param in accepted,
            f"{filename}: {effect} - run() accepts {param}",
            f"signature: {list(accepted)}",
        )
    src = open(os.path.join(HERE, filename)).read()
    submit = src[src.index("def submit("):]
    submit = submit[: submit.index("@app.function")] if "@app.function" in submit else submit
    for param in params:
        check(
            f'payload.get("{param}")' in submit,
            f"{filename}: {effect} - submit() forwards {param} from the request body",
        )

# Every app must expose the async pair, or long clips fall back to a single
# blocking request bounded by Vercel's function timeout.
for filename in ("ltx_app.py", "wan_app.py"):
    fns = set(modules[filename].app.functions)
    check(
        {"submit", "result"} <= fns,
        f"{filename}: exposes the async submit/result pair",
        f"has {sorted(fns)}",
    )


# ── the fp16 fallback, exercised for real ───────────────────────────────────

sdxl = modules["sdxl_app.py"]
calls = []


class FakeNoFp16:
    """A repo published with plain .safetensors only — what John6666 ships."""

    @staticmethod
    def from_pretrained(repo, torch_dtype=None, **kwargs):
        calls.append(kwargs.get("variant"))
        if kwargs.get("variant") == "fp16":
            raise OSError(
                f"Cannot load model {repo}: model is not cached locally and an "
                "error occurred while trying to fetch metadata from the Hub."
            )
        return f"loaded:{repo}"


got = sdxl._load_pipeline(FakeNoFp16, "John6666/lustify-sdxl-nsfw-checkpoint-v20-sdxl", "fp16dtype")
check(
    got == "loaded:John6666/lustify-sdxl-nsfw-checkpoint-v20-sdxl",
    "SDXL loads a checkpoint that has no fp16 variant",
    f"returned {got!r}",
)
check(calls == ["fp16", None], "SDXL tries fp16 first, then falls back", str(calls))

calls.clear()


class FakeHasFp16:
    @staticmethod
    def from_pretrained(repo, torch_dtype=None, **kwargs):
        calls.append(kwargs.get("variant"))
        return f"loaded-fp16:{repo}"


sdxl._load_pipeline(FakeHasFp16, "some/repo", "fp16dtype")
check(calls == ["fp16"], "SDXL still prefers fp16 when the repo has it", str(calls))

# The pose annotator download had no cache_dir and re-ran on every cold start.
src = open(os.path.join(HERE, "sdxl_app.py")).read()
idx = src.find('OpenposeDetector.from_pretrained')
check(
    idx != -1 and 'cache_dir="/cache/hf"' in src[idx:idx + 200],
    "SDXL caches the OpenPose annotator on the volume",
)

if PRINT_REPOS:
    sdxl_mod = modules["sdxl_app.py"]
    repos = [spec["repo"] for spec in sdxl_mod.CHECKPOINTS.values()]
    repos.append(sdxl_mod.POSE_CONTROLNET)
    repos.append("lllyasviel/Annotators")
    repos.append(getattr(sdxl_mod, "LIGHTNING_LORA_REPO", ""))
    repos.append(modules["ltx_app.py"].MODEL_ID)
    repos.append(modules["wan_app.py"].MODEL_ID)
    lora = getattr(modules["wan_app.py"], "LIGHTNING_LORA_REPO", "")
    if lora:
        repos.append(lora)
    seen = set()
    for r in repos:
        if r and r not in seen:
            seen.add(r)
            print(r)
    sys.exit(0)

print()
if failures:
    print(f"check-modal-apps: {len(failures)} of {checks} checks FAILED")
    sys.exit(1)
print(f"check-modal-apps: all {checks} checks passed")
