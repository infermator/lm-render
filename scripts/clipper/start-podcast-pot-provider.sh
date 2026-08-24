#!/usr/bin/env bash
set -uo pipefail

# V3 transcript-only source fallback. This is intentionally not used by the V2
# renderer: the old 1.3.1 experiment degraded video selection to 360p. Version
# 1.3.2 changed WebPO minting, so Podcast audio ingest can retest it safely.
readonly CONTAINER_NAME="clipper-podcast-bgutil"
readonly PROVIDER_IMAGE="brainicism/bgutil-ytdlp-pot-provider:1.3.2"

if ! command -v docker >/dev/null 2>&1; then
  echo '[podcast-source] Docker unavailable; continuing without PO-token fallback'
  exit 0
fi

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
if ! docker run --rm -d --init -p 4416:4416 --name "$CONTAINER_NAME" "$PROVIDER_IMAGE" >/dev/null; then
  echo '[podcast-source] PO-token provider could not start; continuing with WARP/client fallbacks'
  exit 0
fi

for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4416/ping >/dev/null 2>&1; then
    echo '[podcast-source] Podcast-only anonymous PO-token provider ready'
    exit 0
  fi
  if ! docker ps --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    break
  fi
  sleep 1
done

echo '[podcast-source] PO-token provider did not become ready; continuing with WARP/client fallbacks'
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
exit 0
