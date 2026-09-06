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
- The **SDXL checkpoint repos are the least certain part** — they are the one
  thing that could not be derived from the client at all, only guessed from the
  names `lustify` and `wai-illustrious`. Confirm before trusting them.
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
