#!/usr/bin/env bash
set -uo pipefail

# Wrapper for yt-dlp on shared GitHub-hosted runners. YouTube frequently
# challenges those egress IPs with HTTP 429 / bot checks. Keep the normal
# anonymous path, support a small set of official-client fallbacks, then use a
# local BotGuard PO-token provider when available. Cookies/proxy remain optional
# last-mile overrides and are never printed.

COOKIE_FILE=""
cleanup() {
  if [ -n "$COOKIE_FILE" ] && [ -f "$COOKIE_FILE" ]; then
    rm -f "$COOKIE_FILE"
  fi
}
trap cleanup EXIT

EXTRA=()
if [ -n "${YOUTUBE_COOKIES_B64:-}" ]; then
  COOKIE_FILE="$(mktemp)"
  chmod 600 "$COOKIE_FILE"
  if ! printf '%s' "$YOUTUBE_COOKIES_B64" | base64 --decode > "$COOKIE_FILE" 2>/dev/null; then
    echo '[clipper-source] YOUTUBE_COOKIES_B64 is present but is not valid base64' >&2
    exit 64
  fi
  EXTRA+=(--cookies "$COOKIE_FILE")
  echo '[clipper-source] YouTube cookies enabled'
elif [ -n "${YOUTUBE_COOKIES:-}" ]; then
  COOKIE_FILE="$(mktemp)"
  chmod 600 "$COOKIE_FILE"
  printf '%s' "$YOUTUBE_COOKIES" > "$COOKIE_FILE"
  EXTRA+=(--cookies "$COOKIE_FILE")
  echo '[clipper-source] YouTube cookies enabled'
fi

if [ -n "${YOUTUBE_PROXY_URL:-}" ]; then
  EXTRA+=(--proxy "$YOUTUBE_PROXY_URL")
  # --download-sections hands the byte-range fetch to ffmpeg, and the
  # googlevideo URL is bound to the address that resolved the player response.
  # ffmpeg cannot speak SOCKS but does honour http_proxy, so export the proxy
  # here: only yt-dlp and the ffmpeg it spawns inherit it, while render.mjs
  # keeps talking to Reaction Lab and Supabase over direct egress.
  case "$YOUTUBE_PROXY_URL" in
    http://*|https://*)
      export http_proxy="$YOUTUBE_PROXY_URL"
      export https_proxy="$YOUTUBE_PROXY_URL"
      ;;
  esac
  echo '[clipper-source] YouTube proxy enabled'
fi

run_attempt() {
  local label="$1"
  shift
  local log
  log="$(mktemp)"
  echo "[clipper-source] yt-dlp attempt: $label"
  python -m yt_dlp "${EXTRA[@]}" "$@" 2> >(tee "$log" >&2)
  local code=$?
  if [ "$code" -eq 0 ]; then
    rm -f "$log"
    return 0
  fi

  if grep -Eqi 'HTTP Error 429|Too Many Requests|Sign in to confirm you.re not a bot|confirm you.re not a bot' "$log"; then
    export CLIPPER_YOUTUBE_BOT_BLOCKED=1
  fi
  rm -f "$log"
  return "$code"
}

# 1) Preserve the exact renderer request first.
if run_attempt default "$@"; then
  exit 0
fi

# 2) Cheap official-client fallback. Keep this to one attempt so challenged
# shared egress is not hammered with retries.
if run_attempt alternate-client --extractor-args 'youtube:player_client=web_safari,android_vr' "$@"; then
  exit 0
fi

# 3) Podcast V3 can opt into the maintainer-backed WebPoClient provider. It
# drives a real browser through the same yt-dlp proxy and can mint both Player
# and GVS tokens. V2 deliberately never enables or installs this experiment.
if [ "${CLIPPER_PODCAST_WPC_ENABLED:-0}" = '1' ] && [ -n "${CLIPPER_PODCAST_BROWSER_PATH:-}" ]; then
  if run_attempt podcast-mweb-browser-pot \
    --extractor-args 'youtube:player_client=mweb;fetch_pot=always;pot_trace=true' \
    --extractor-args "youtubepot-wpc:browser_path=${CLIPPER_PODCAST_BROWSER_PATH}" \
    "$@"; then
    exit 0
  fi
fi

if [ "${CLIPPER_YOUTUBE_BOT_BLOCKED:-0}" = '1' ]; then
  echo '[clipper-source] youtube_bot_blocked: YouTube rejected this egress even after the official-client fallback. The worker normally materializes sources through Cloudflare WARP; check that the WARP step reported active egress for this run.' >&2
  exit 42
fi

echo '[clipper-source] youtube_source_download_failed: yt-dlp failed after all safe source attempts.' >&2
exit 1
