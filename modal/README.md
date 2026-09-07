# Modal apps (self-hosted media)

The three Modal apps behind the self-hosted options in Media Studio and the
chat handoff. They are the cheap path: L4, scale-to-zero, no external content
filter.

| App | Endpoint | Called by |
|---|---|---|
| `wan-video` | `ic4pi--wan-video-generate.modal.run` | `generateModalWanVideo()` |
| `ltx-video` | `ic4pi--ltx-video-generate.modal.run` | `generateModalLtxVideo()` |
| `sdxl-nsfw` | `ic4pi--sdxl-nsfw-generate.modal.run` | `generateModalSdxlImage()` |

All three are consumed by `api/media-generate.js`. Override any endpoint with
`MODAL_WAN_ENDPOINT`, `MODAL_LTX_ENDPOINT`, `MODAL_SDXL_ENDPOINT`.

## ⚠️ These files are reconstructed, not recovered

**The source that is actually deployed on Modal has never been in this repo.**
Checked: 8,132 files across the entire git history, zero `.py`. It exists only
inside Modal.

These files were rebuilt from the contract the client encodes — endpoint names,
request bodies, response keys, frame counts, fps, the 6-clip cap, the two SDXL
checkpoint names — plus the working Wan 2.2 pipeline in `worker-template`. The
diffusers call signatures were verified against `diffusers==0.36.0`.

They have **not** been run on a GPU and **not** diffed against what is live.

So:

- **Do not `modal deploy` these over a working app** expecting a no-op. Deploy
  to a differently-named app first and compare output.
- The **SDXL checkpoint repos were guessed, and both guesses were wrong.** They
  are the one thing that could not be derived from the client at all, only
  inferred from the names `lustify` and `wai-illustrious`. The Hub answered 401
  for `John6666/lustify-sdxl-nsfw-checkpoint-v20-sdxl` and
  `John6666/wai-nsfw-illustrious-sdxl-v110-sdxl`, so every image request died
  loading the checkpoint and reported it as a Hub metadata error — which reads
  like a network fault, and hid the real cause for days. They now point at
  repos confirmed reachable. **Never change a model id without re-running the
  preflight:** the *Deploy Modal apps* workflow with `mode: probe` reports the
  status of every repo all three apps pull, and a `deploy` run refuses to build
  when one is unreachable.
- Everything else (names, shapes, dimensions, caps) is pinned by the client and
  by `scripts/check-modal-endpoints.mjs`.

### Replace this with the real thing when you can

Modal retains the source of deployed apps. Pull it from the app's page in the
Modal dashboard (or `modal app list` to enumerate, then open each one), drop the
real files in over these, and delete this warning. That is a ~10 minute job and
it is worth doing before anything here gets deployed.

## Verifying the live apps

```bash
node scripts/check-modal-endpoints.mjs          # wan + ltx
node scripts/check-modal-endpoints.mjs --all    # + sdxl
```

Sends the byte-exact request `api/media-generate.js` sends and asserts the exact
response keys it reads back, so client/app drift surfaces here instead of as a
dead button. Run it from a machine that can reach `*.modal.run`. First run after
an idle period pays a cold start — several minutes is normal, not a failure.

It also warns when a response exceeds **4.5MB**, which is where Vercel 413s. A
long video will cross that line; the chat path handles it by uploading to
storage rather than inlining (`lib/hub.js`), but Media Studio returns it inline.

## Deploying

```bash
pip install modal && modal setup
modal deploy modal/wan_app.py     # -> ic4pi--wan-video-generate.modal.run
```

The URL is derived from the app name plus the web-endpoint function name, so
**renaming `App("wan-video")` or the `generate` function changes the URL** and
breaks the client. That naming is load-bearing.

## Shape

Each app is a GPU class holding the weights plus a thin CPU `generate` endpoint
that calls into it — which is why the Modal dashboard lists two entries per app
(`Wan.*` and `generate`). Keeping the front door off the GPU means a queued
request is not holding an L4.

Video is generated as chained ~5s clips rather than one long pass: the last
frame of each clip seeds the next. Quality and speed per clip stay flat, where
a single long generation degrades and risks the timeout. The client caps clips
at 6 and each app re-clamps server-side, since the endpoints are reachable
directly.

## Cost

`lib/video-billing.js` prices generations off an assumed **$0.80/hr L4**
(`MODAL_L4_RATE_PER_HOUR` to override). That figure is a local estimate for
splitting cost between access keys — it is not read from Modal billing, so it
drifts if Modal changes pricing. Check <https://modal.com/pricing>.

## Speed work (Lightning, warming, offload)

Three changes landed here after measuring the original setup:

**Wan runs a Lightning LoRA.** Step-distilled: ~4 sampling steps instead of 40,
and no classifier-free guidance, which removes the unconditional pass as well.
Together that is roughly an order of magnitude fewer transformer evaluations.
`guidance_scale` is forced to 1.0 whenever the LoRA is active — a distilled
model given real CFG produces burnt, oversaturated frames.

If the LoRA fails to load the app logs it and falls back to 40 steps at CFG 5.0,
so a bad repo name degrades speed rather than breaking generation. The response
carries `fast` and `steps` so you can tell which path ran. Override the source
with `WAN_LIGHTNING_LORA_REPO` (empty string disables it) and
`WAN_LIGHTNING_LORA_WEIGHT` for a specific file inside the repo.

**After deploying this, re-time a clip and raise `maxSeconds` for Wan in
`public/media/media.js`.** That cap is 5s because a 40-step clip took 6m20s;
Lightning should make several chained clips fit inside the 800s function
window. The cap is deliberately left low until someone measures.

**SDXL is no longer offloaded.** It is ~7GB in fp16 against the L4's 24GB, so
`enable_model_cpu_offload()` was moving weights across PCIe every step to solve
a memory problem that does not exist. It now sits resident and uses DPM++ 2M
Karras at 22 steps. Set `SDXL_CPU_OFFLOAD=1` to restore offloading on a
smaller card.

LTX keeps offloading by default — it carries a T5-XXL text encoder and
121-frame activations, and whether that fits an L4 is too close to call without
measuring. `LTX_CPU_OFFLOAD=0` turns it off if you want to time it.

**Each app exposes a `warm` endpoint** alongside `generate`, at the same URL
with the function name swapped (`ic4pi--wan-video-warm.modal.run`). It spawns
a no-op `ping()` method; `@modal.enter()` has already loaded the weights by the
time that runs, so the container comes up without generating anything. The
Media Studio prompt box fires it on focus through `/api/media-generate?op=warm`,
which overlaps the ~60s cold start with the time someone spends typing.

Warming costs about one cent on an L4 and is fire-and-forget: failures are
silent, and a warm that does not land just means the generation pays the cold
start it would have paid anyway.

## Modes

Beyond plain text-to-X, each app exposes modes that reuse the same loaded
weights. Every sibling pipeline is constructed from the base pipeline's
`.components` rather than loaded again, so a mode costs no extra VRAM and no
extra cold start — but it also means swapping the SDXL checkpoint has to
discard the siblings built over the outgoing one.

**Images** (`mode` in the request):

| Mode | Needs | Notes |
|---|---|---|
| `text` | — | Default |
| `img2img` | source image, `strength` | Low strength restyles, high strength uses the source as loose composition |
| `expand` / `outpaint` | source image, `expand` px per side | Builds the canvas and mask server-side |
| `pose` | photo or skeleton, `control_scale` | `detect_pose` converts a photo; a drawn stick figure is used as-is |

Outpainting stretches and blurs the source across the enlarged canvas as a base
coat before pasting the original back at full resolution, and feathers the mask
edge. A flat fill under the mask bleeds its colour into the result and leaves a
hard seam where new meets original.

Pose control needs an OpenPose ControlNet — `SDXL_POSE_CONTROLNET`, defaulting
to `xinsir/controlnet-openpose-sdxl-1.0`. Photo detection additionally pulls
`lllyasviel/Annotators` through `controlnet_aux` on first use.

**Video:**

- **Wan `video` + `strength`** — restyles an existing clip through
  `WanVideoToVideoPipeline`. Single pass, not a chain: the source already
  carries the motion the chain exists to invent. Frames are sampled evenly
  across the clip rather than truncated, so a long source is covered rather
  than having its tail dropped.
- **LTX `keyframes`** — a list of `{image, frame, strength}` handed to
  `LTXConditionPipeline` as `LTXVideoCondition` objects. Images are pinned to
  frame indices and LTX invents the motion between them. Also a single pass,
  for the same reason.

Both replace the clip chain rather than adding to it, so `num_clips` is ignored
when either is present.

**A source clip must fit in a 3MB request.** Vercel caps bodies at 4.5MB and
browsers cannot practically re-encode video, so Media Studio rejects anything
larger up front with the actual size rather than letting it fail as a 413. A
few seconds at 480p fits. Lifting this needs the browser to upload straight to
storage and hand the app a URL.

## Deploying side by side

`MODAL_APP_NAME` overrides the app name at deploy time, so these can go up
next to the existing apps rather than over them:

```bash
pip install modal && modal setup

MODAL_APP_NAME=sdxl-nsfw-v2 modal deploy modal/sdxl_app.py
MODAL_APP_NAME=ltx-video-v2 modal deploy modal/ltx_app.py
MODAL_APP_NAME=wan-video-v2 modal deploy modal/wan_app.py
```

Then point the site at them — Vercel → project → Settings → Environment
Variables, Production:

```
MODAL_SDXL_ENDPOINT = https://ic4pi--sdxl-nsfw-v2-generate.modal.run
MODAL_LTX_ENDPOINT  = https://ic4pi--ltx-video-v2-generate.modal.run
MODAL_WAN_ENDPOINT  = https://ic4pi--wan-video-v2-generate.modal.run
```

Redeploy, then test. **Deleting those three variables reverts to the original
apps** — the defaults are compiled in — so a bad deploy costs one env-var
change, not a working generator.

Verify with `npm run check:modal -- --all` from a machine that can reach
`*.modal.run`.
