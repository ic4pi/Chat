# RunPod ComfyUI · Wan 2.2 TI2V 5B (cheap self-host for this site)

## Why 5B (not 14B)

| Model | VRAM | Pod cost vibe | Notes |
|-------|------|---------------|-------|
| **Wan 2.2 TI2V 5B** (recommended) | ~8–16 GB (4090 is comfortable) | Cheap community / RTX 4090 | Text **and** image → video in one model |
| Wan 2.2 14B T2V/I2V | 24 GB+ | 2–4× cost / slower | Better quality; not needed to start |

Use **5B @ 832×480, 2–3 seconds** for the best $/clip. Step up to 14B later only if quality is worth the bill.

## What this repo already wires

Media Studio → `/api/media-generate` with:

- `provider: "runpod"`
- models: `wan2.2-5b-t2v` / `wan2.2-5b-i2v`

Env vars (Vercel → Project → Environment Variables):

| Var | Purpose |
|-----|---------|
| `RUNPOD_API_KEY` | RunPod API key |
| `RUNPOD_ENDPOINT_ID` | Serverless endpoint id (worker-comfyui) |
| `COMFYUI_BASE_URL` | Optional: live Pod ComfyUI URL (`https://…-8188.proxy.runpod.net`) instead of serverless |

Code:

- `lib/comfy/wan22-5b-workflow.js` — API workflow builder (prompt / size / frames / i2v)
- `lib/comfy/runpod-comfy.js` — `/run` + status poll (or direct ComfyUI)
- `scripts/runpod/download-wan22-5b.sh` — model download on a Pod
- `scripts/runpod/test-wan22-endpoint.sh` — smoke test

---

## Path A — Serverless (best for the website)

Pay per second, scales to zero when idle.

### 1. Network volume (models persist)

1. RunPod console → **Storage** → create a **Network Volume** (EU/US next to your GPUs), **≥ 40 GB**.
2. Attach it later to both the setup Pod and the Serverless endpoint.

### 2. One-time model download Pod

1. **Pods** → deploy **RTX 4090** (or 3090) with a **ComfyUI** template (official RunPod ComfyUI is fine).
2. Attach the network volume at `/workspace` (or wherever the template mounts ComfyUI).
3. Open a terminal on the Pod and run:

```bash
# If this repo is cloned on the volume:
bash scripts/runpod/download-wan22-5b.sh

# Or set the ComfyUI root explicitly:
COMFYUI_DIR=/workspace/ComfyUI bash scripts/runpod/download-wan22-5b.sh
```

Models land in:

```
ComfyUI/models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors
ComfyUI/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
ComfyUI/models/vae/wan2.2_vae.safetensors
```

4. Open ComfyUI `:8188` → **Workflow → Browse Templates → Video → Wan2.2 5B** → Queue once to confirm.
5. Stop the Pod (models stay on the volume).

### 3. Serverless endpoint (worker-comfyui)

1. RunPod → **Serverless** → **New Endpoint**.
2. Image: latest `runpod/worker-comfyui:<tag>-base`  
   (Hub: https://github.com/runpod-workers/worker-comfyui — use a current release tag).
3. Attach the **same network volume**; set the worker’s ComfyUI models path to that volume (see worker [Customization / Network Volume](https://github.com/runpod-workers/worker-comfyui/blob/main/docs/customization.md) docs).
4. GPU: **RTX 4090** (or 48GB if you later move to 14B).
5. Workers: min **0**, max **1–2** (cheap). Idle timeout ~5–15s.
6. Copy **Endpoint ID**.

**Strongly recommended:** enable **S3/R2 upload** on the worker (env vars in the worker [Configuration guide](https://github.com/runpod-workers/worker-comfyui/blob/main/docs/configuration.md)).  
Vercel caps API responses at **4.5 MB**. Short clips as base64 can fit; longer ones need a **URL**.

### 4. Website env

In Vercel:

```
RUNPOD_API_KEY=rpa_...
RUNPOD_ENDPOINT_ID=your-endpoint-id
```

Redeploy. In **Media → Video** pick **RunPod · Wan 2.2 5B**.

### 5. Smoke test from your laptop

```bash
export RUNPOD_API_KEY=...
export RUNPOD_ENDPOINT_ID=...
bash scripts/runpod/test-wan22-endpoint.sh "cat walking through neon rain, cinematic"
```

---

## Path B — Always-on Pod (simpler, costs while running)

1. Deploy ComfyUI Pod + download models (same as A.2).
2. Keep the Pod running; open port **8188**.
3. Set on Vercel:

```
COMFYUI_BASE_URL=https://<pod-id>-8188.proxy.runpod.net
```

(No endpoint id needed.) Stop the Pod when idle or you burn credits.

---

## Using it in Media Studio

1. Tab **Video**
2. Model **RunPod · Wan 2.2 5B Text → Video** (or Image → Video + upload)
3. Size **832×480**, duration **2–3 sec** until S3 URLs are enabled
4. Generate (first serverless cold start can take a few minutes)

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `503 RunPod Wan is not configured` | Missing `RUNPOD_API_KEY` / `RUNPOD_ENDPOINT_ID` (or `COMFYUI_BASE_URL`) on Vercel + redeploy |
| Model / node errors on worker | Re-run download script; ComfyUI build must be new enough for `Wan22ImageToVideoLatent`, `CreateVideo`, `SaveVideo` |
| HTTP 413 on result | Enable worker S3/R2 **or** shorten duration / resolution |
| Cold starts slow | Raise min workers to 1 (costs idle $) or keep a Pod warm |
| i2v ignores image | Use the **Image → Video** model entry so the upload is attached |

---

## Cost tips

- Prefer **serverless + min workers 0**
- Stick to **5B + 832×480 + ≤3s** for daily use
- Enable **R2/S3** so Vercel only stores a short URL, not the MP4
- Don’t leave a 4090 Pod running overnight unless you mean to
