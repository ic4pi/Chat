#!/usr/bin/env bash
# Download Wan 2.2 TI2V 5B models into a ComfyUI models tree (RunPod Pod or local).
# Usage (inside the Pod terminal, ComfyUI root or with COMFYUI_DIR set):
#   bash scripts/runpod/download-wan22-5b.sh
#
# Optional:
#   COMFYUI_DIR=/workspace/ComfyUI bash scripts/runpod/download-wan22-5b.sh
#   HF_TOKEN=hf_xxx  # only if Hugging Face rate-limits you

set -euo pipefail

COMFYUI_DIR="${COMFYUI_DIR:-${PWD}}"
# Common RunPod layouts
if [[ ! -d "${COMFYUI_DIR}/models" ]]; then
  for candidate in /workspace/ComfyUI /workspace/comfyui "${PWD}/ComfyUI"; do
    if [[ -d "${candidate}/models" ]]; then
      COMFYUI_DIR="$candidate"
      break
    fi
  done
fi

DIFF="${COMFYUI_DIR}/models/diffusion_models"
TE="${COMFYUI_DIR}/models/text_encoders"
VAE="${COMFYUI_DIR}/models/vae"
mkdir -p "$DIFF" "$TE" "$VAE"

HF_HDR=()
if [[ -n "${HF_TOKEN:-}" ]]; then
  HF_HDR=(-H "Authorization: Bearer ${HF_TOKEN}")
fi

download() {
  local url="$1"
  local out="$2"
  if [[ -f "$out" ]]; then
    echo "skip (exists): $out"
    return 0
  fi
  echo "download → $out"
  curl -L --fail --retry 3 --retry-delay 2 "${HF_HDR[@]}" -o "$out.partial" "$url"
  mv "$out.partial" "$out"
}

BASE_DIFF="https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files"
BASE_TE="https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files"

download "${BASE_DIFF}/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors" \
  "${DIFF}/wan2.2_ti2v_5B_fp16.safetensors"
download "${BASE_DIFF}/vae/wan2.2_vae.safetensors" \
  "${VAE}/wan2.2_vae.safetensors"
download "${BASE_TE}/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors" \
  "${TE}/umt5_xxl_fp8_e4m3fn_scaled.safetensors"

echo
echo "Done. Models under: ${COMFYUI_DIR}/models"
echo "Next: export API workflow in ComfyUI (Workflow → Export API) OR use the"
echo "built-in builder in lib/comfy/wan22-5b-workflow.js for the website."
ls -lh "$DIFF/wan2.2_ti2v_5B_fp16.safetensors" "$VAE/wan2.2_vae.safetensors" "$TE/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
