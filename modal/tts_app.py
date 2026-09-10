"""
Character voices on Modal — the `voice-tts` app.

Serves POST https://ic4pi--voice-tts-speak.modal.run, consumed by the
?op=speak route in api/media-generate.js.

    request   {text, voice?, exaggeration?, cfg_weight?, gap?}
    response  {audio_base64, mime, seconds, elapsed_seconds, cloned}

`voice` is a short reference recording (~5s of clean speech, one speaker).
Given one, Chatterbox clones it zero-shot; without one it uses its default
voice. That reference is what makes a recurring character sound like itself
across every video — the same role the locked seed plays for the picture.

Chatterbox rather than the alternatives because of licensing as much as
quality: it is MIT, where F5-TTS's weights are CC-BY-NC and XTTS is CPML —
both non-commercial. Kokoro is Apache and lighter, but cannot clone a voice
at all, which is the whole point here.

Deploy:  modal deploy modal/tts_app.py
"""

import base64
import io
import os
import subprocess
import tempfile
import time

import modal

MAX_CHARS = 4000
# Multi-line input is generated a line at a time and rejoined, so a long
# speech does not have to survive as one utterance.
MAX_LINES = 40
DEFAULT_GAP_MS = 350

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    # Deliberately unpinned: this was written without a deploy to verify a
    # working version against, and a guessed pin fails more confusingly than
    # none. Pin it to whatever the first green deploy resolves.
    .pip_install("chatterbox-tts", "torchaudio", "fastapi[standard]")
)

app = modal.App(os.environ.get("MODAL_APP_NAME", "voice-tts"))
cache = modal.Volume.from_name("tts-model-cache", create_if_missing=True)

SHARED_SECRET = os.environ.get("MODAL_SHARED_SECRET", "")


def _check_secret(request) -> None:
    if not SHARED_SECRET:
        return
    import fastapi

    if request.headers.get("X-Modal-Secret") != SHARED_SECRET:
        raise fastapi.HTTPException(status_code=401, detail="Bad or missing X-Modal-Secret.")


def _decode(data: str) -> bytes:
    """Accept a bare base64 string or a full data: URL."""
    if data.startswith("data:"):
        data = data.split(",", 1)[-1]
    return base64.b64decode(data)


@app.cls(
    gpu="L4",
    image=image,
    volumes={"/cache": cache},
    scaledown_window=300,
    timeout=1800,
)
class Voice:
    @modal.enter()
    def load(self):
        from chatterbox.tts import ChatterboxTTS

        os.environ["HF_HOME"] = "/cache/hf"
        self.model = ChatterboxTTS.from_pretrained(device="cuda")

    @modal.method()
    def ping(self) -> dict:
        return {"ready": True}

    @modal.method()
    def speak(
        self,
        text: str,
        voice: str = "",          # reference recording to clone, base64 or data URL
        exaggeration: float = 0.5,
        cfg_weight: float = 0.5,
        gap_ms: int = DEFAULT_GAP_MS,
    ) -> dict:
        import torch
        import torchaudio as ta

        started = time.time()
        lines = [l.strip() for l in str(text).split("\n") if l.strip()][:MAX_LINES]
        if not lines:
            raise ValueError("No text to speak.")

        with tempfile.TemporaryDirectory() as tmp:
            prompt_path = None
            if voice:
                # Written to disk because Chatterbox takes a path, not bytes.
                prompt_path = os.path.join(tmp, "ref.wav")
                with open(prompt_path, "wb") as fh:
                    fh.write(_decode(voice))

            gap = torch.zeros(1, int(self.model.sr * max(0, gap_ms) / 1000))
            chunks = []
            for i, line in enumerate(lines):
                wav = self.model.generate(
                    line,
                    **({"audio_prompt_path": prompt_path} if prompt_path else {}),
                    exaggeration=exaggeration,
                    cfg_weight=cfg_weight,
                )
                # generate() returns (1, samples) on the model's device.
                wav = wav.detach().cpu()
                if wav.dim() == 1:
                    wav = wav.unsqueeze(0)
                if i:
                    chunks.append(gap)
                chunks.append(wav)

            full = torch.cat(chunks, dim=1)
            wav_path = os.path.join(tmp, "out.wav")
            ta.save(wav_path, full, self.model.sr)

            # mp3 rather than wav: the track has to fit inside the site's 3MB
            # request budget on its way back out to be laid over a clip, and
            # raw 24kHz wav spends that in about a minute of speech.
            mp3_path = os.path.join(tmp, "out.mp3")
            subprocess.run(
                ["ffmpeg", "-y", "-i", wav_path, "-c:a", "libmp3lame", "-b:a", "128k", mp3_path],
                check=True, capture_output=True, timeout=300,
            )
            with open(mp3_path, "rb") as fh:
                audio_b64 = base64.b64encode(fh.read()).decode()

        return {
            "audio_base64": audio_b64,
            "mime": "audio/mpeg",
            "seconds": round(full.shape[1] / self.model.sr, 2),
            "lines": len(lines),
            "cloned": bool(voice),
            "elapsed_seconds": round(time.time() - started, 2),
        }


@app.function(image=image, timeout=1800)
@modal.fastapi_endpoint(method="POST")
def speak(payload: dict, request=None) -> dict:
    if request is not None:
        _check_secret(request)

    text = (payload.get("text") or "").strip()
    if not text:
        return {"error": "Missing 'text'."}
    if len(text) > MAX_CHARS:
        return {"error": f"Text is {len(text)} characters; the ceiling is {MAX_CHARS}."}

    try:
        return Voice().speak.remote(
            text=text,
            voice=payload.get("voice") or "",
            exaggeration=float(payload.get("exaggeration") or 0.5),
            cfg_weight=float(payload.get("cfg_weight") or 0.5),
            gap_ms=int(payload.get("gap_ms") or DEFAULT_GAP_MS),
        )
    except Exception as exc:
        import traceback

        return {
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": "".join(traceback.format_exc()).strip()[-3000:],
        }


@app.function(image=image, timeout=60)
@modal.fastapi_endpoint(method="POST")
def warm(request=None) -> dict:
    if request is not None:
        _check_secret(request)
    try:
        Voice().ping.spawn()
        return {"warming": True}
    except Exception as exc:
        return {"warming": False, "error": f"{type(exc).__name__}: {exc}"}
