#!/usr/bin/env bash
# Smoke-test a RunPod serverless ComfyUI endpoint with a tiny Wan 2.2 workflow.
# Requires: jq, curl, RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID
#
#   export RUNPOD_API_KEY=...
#   export RUNPOD_ENDPOINT_ID=...
#   bash scripts/runpod/test-wan22-endpoint.sh

set -euo pipefail

: "${RUNPOD_API_KEY:?Set RUNPOD_API_KEY}"
: "${RUNPOD_ENDPOINT_ID:?Set RUNPOD_ENDPOINT_ID}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROMPT="${1:-A golden retriever running on a beach at sunset, cinematic, smooth motion}"

# Build workflow JSON via node
WORKFLOW="$(node --input-type=module -e "
import { buildWan225bWorkflow } from './lib/comfy/wan22-5b-workflow.js';
const wf = buildWan225bWorkflow({
  prompt: process.argv[1],
  width: 832,
  height: 480,
  length: 41,
  steps: 16,
});
process.stdout.write(JSON.stringify({ input: { workflow: wf } }));
" "$PROMPT")"

echo "Submitting /run …"
JOB="$(curl -sS -X POST \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$WORKFLOW" \
  "https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/run")"

echo "$JOB" | jq .
ID="$(echo "$JOB" | jq -r '.id // empty')"
if [[ -z "$ID" ]]; then
  echo "No job id — aborting" >&2
  exit 1
fi

echo "Polling $ID …"
for i in $(seq 1 80); do
  sleep 4
  ST="$(curl -sS -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
    "https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/status/${ID}")"
  STATUS="$(echo "$ST" | jq -r '.status')"
  echo "[$i] $STATUS"
  if [[ "$STATUS" == "COMPLETED" ]]; then
    echo "$ST" | jq '{status, delayTime, executionTime, outputKeys: (.output|keys)}'
    exit 0
  fi
  if [[ "$STATUS" == "FAILED" || "$STATUS" == "CANCELLED" || "$STATUS" == "TIMED_OUT" ]]; then
    echo "$ST" | jq . >&2
    exit 1
  fi
done

echo "Timed out waiting for job" >&2
exit 1
