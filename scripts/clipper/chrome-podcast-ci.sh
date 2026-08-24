#!/usr/bin/env bash
set -euo pipefail

# Chrome's namespace sandbox cannot initialize inside some GitHub-hosted
# runner images. This launcher is handed only to the Podcast V3 WebPoClient
# token provider; Stream V2 never sets the opt-in flag that reaches it.
browser_path="${CLIPPER_PODCAST_REAL_BROWSER_PATH:-}"
if [ -z "$browser_path" ] || [ ! -x "$browser_path" ]; then
  echo '[podcast-source] configured Chrome executable is unavailable' >&2
  exit 64
fi

exec "$browser_path" --no-sandbox "$@"
