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

AUTH_EXTRA=()
PROXY_EXTRA=()
if [ -n "${YOUTUBE_COOKIES_B64:-}" ]; then
  COOKIE_FILE="$(mktemp)"
  chmod 600 "$COOKIE_FILE"
  if ! printf '%s' "$YOUTUBE_COOKIES_B64" | base64 --decode > "$COOKIE_FILE" 2>/dev/null; then
    echo '[clipper-source] YOUTUBE_COOKIES_B64 is present but is not valid base64' >&2
    exit 64
  fi
  AUTH_EXTRA+=(--cookies "$COOKIE_FILE")
  echo '[clipper-source] YouTube cookies enabled'
elif [ -n "${YOUTUBE_COOKIES:-}" ]; then
  COOKIE_FILE="$(mktemp)"
  chmod 600 "$COOKIE_FILE"
  printf '%s' "$YOUTUBE_COOKIES" > "$COOKIE_FILE"
  AUTH_EXTRA+=(--cookies "$COOKIE_FILE")
  echo '[clipper-source] YouTube cookies enabled'
fi

if [ -n "${YOUTUBE_PROXY_URL:-}" ]; then
  PROXY_EXTRA+=(--proxy "$YOUTUBE_PROXY_URL")
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
  local timeout_seconds="${CLIPPER_YTDLP_ATTEMPT_TIMEOUT_SECONDS:-0}"
  if [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
    timeout --foreground "${timeout_seconds}s" python -m yt_dlp "${AUTH_EXTRA[@]}" "${PROXY_EXTRA[@]}" "$@" 2> >(tee "$log" >&2)
  else
    python -m yt_dlp "${AUTH_EXTRA[@]}" "${PROXY_EXTRA[@]}" "$@" 2> >(tee "$log" >&2)
  fi
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

run_direct_attempt() {
  local label="$1"
  shift
  local log
  log="$(mktemp)"
  echo "[clipper-source] yt-dlp attempt: $label"
  local timeout_seconds="${CLIPPER_YTDLP_ATTEMPT_TIMEOUT_SECONDS:-60}"
  env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
    timeout --foreground "${timeout_seconds}s" python -m yt_dlp "${AUTH_EXTRA[@]}" "$@" 2> >(tee "$log" >&2)
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

# Podcast V3 owns the extra source recovery below. Stream V2 keeps the exact
# historical default -> alternate-client sequence.
if [ "${CLIPPER_PODCAST_WPC_ENABLED:-0}" = '1' ]; then
  # A signed googlevideo URL can occasionally be rejected even though the
  # player request succeeded. Re-extract once before changing clients.
  sleep 2
  if run_attempt podcast-default-retry --force-overwrites "$@"; then
    exit 0
  fi

  # Prefer a small progressive source when adaptive range URLs are rejected.
  # Never let the installed browser provider auto-launch during these cheap
  # fallbacks; the explicit, time-bounded WPC attempt below owns that path.
  if run_attempt podcast-tv-progressive \
    --extractor-args 'youtube:player_client=tv_downgraded;fetch_pot=never' \
    --force-overwrites "$@" --format '18/b'; then
    exit 0
  fi

  # If WARP itself is unhealthy, extract and download through the runner's
  # direct address so the media URL and ffmpeg use the same egress identity.
  if [ -n "${YOUTUBE_PROXY_URL:-}" ] && CLIPPER_YTDLP_ATTEMPT_TIMEOUT_SECONDS=60 run_direct_attempt podcast-direct-progressive \
    --extractor-args 'youtube:player_client=tv_downgraded;fetch_pot=never' \
    --force-overwrites "$@" --format '18/b'; then
    exit 0
  fi

  if run_attempt podcast-alternate-client \
    --extractor-args 'youtube:player_client=web_safari,android_vr;fetch_pot=never' \
    --force-overwrites "$@"; then
    exit 0
  fi
else
  # V2 sequence remains intentionally unchanged.
  if run_attempt alternate-client --extractor-args 'youtube:player_client=web_safari,android_vr' "$@"; then
    exit 0
  fi
fi

# 3) Podcast V3 can opt into the maintainer-backed WebPoClient provider. It
# drives a real browser through the same yt-dlp proxy and can mint both Player
# and GVS tokens. V2 deliberately never enables or installs this experiment.
if [ "${CLIPPER_PODCAST_WPC_ENABLED:-0}" = '1' ] && [ -n "${CLIPPER_PODCAST_BROWSER_PATH:-}" ]; then
  if CLIPPER_YTDLP_ATTEMPT_TIMEOUT_SECONDS=90 run_attempt podcast-mweb-browser-pot \
    --extractor-args 'youtube:player_client=mweb;fetch_pot=always;pot_trace=true' \
    --extractor-args "youtubepot-wpc:browser_path=${CLIPPER_PODCAST_BROWSER_PATH}" \
    --force-overwrites "$@" --format '18/b'; then
    exit 0
  fi
fi

if [ "${CLIPPER_YOUTUBE_BOT_BLOCKED:-0}" = '1' ]; then
  echo '[clipper-source] youtube_bot_blocked: YouTube rejected this egress even after the official-client fallback. The worker normally materializes sources through Cloudflare WARP; check that the WARP step reported active egress for this run.' >&2
  exit 42
fi

echo '[clipper-source] youtube_source_download_failed: yt-dlp failed after all safe source attempts.' >&2
exit 1
