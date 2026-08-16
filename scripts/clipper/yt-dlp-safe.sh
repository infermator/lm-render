#!/usr/bin/env bash
set -uo pipefail

# Wrapper for yt-dlp on shared GitHub-hosted runners. YouTube frequently
# challenges those egress IPs with HTTP 429 / bot checks. Keep the normal
# anonymous path, support official-client and PO-token fallbacks, then resolve
# the same public video through unauthenticated Piped instances. Piped returns
# proxied media URLs, so the GitHub runner no longer has to fetch media from
# YouTube directly. Cookies/proxy remain optional last-mile overrides only.

COOKIE_FILE=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# 3) Current yt-dlp guidance recommends an mweb PO-token provider when YouTube
# enforces BotGuard/Proof-of-Origin. The worker starts bgutil locally, so no
# account session is required for this path.
if [ "${CLIPPER_BGUTIL_ENABLED:-0}" = '1' ]; then
  BGUTIL_BASE_URL="${BGUTIL_BASE_URL:-http://127.0.0.1:4416}"
  if run_attempt po-token-mweb \
    --extractor-args 'youtube:player_client=mweb' \
    --extractor-args "youtubepot-bgutilhttp:base_url=${BGUTIL_BASE_URL}" \
    "$@"; then
    exit 0
  fi
fi

# 4) Login-free public fallback. Piped's /streams API is unauthenticated and
# returns media through its own proxy/CDN. This specifically avoids the GitHub
# datacenter-IP -> YouTube hop that caused the bot-check failures above.
if [ "${CLIPPER_YOUTUBE_BOT_BLOCKED:-0}" = '1' ] && [ "${CLIPPER_PIPED_ENABLED:-1}" != '0' ]; then
  echo '[clipper-source] direct YouTube blocked; trying free Piped proxy fallback'
  if node "$SCRIPT_DIR/piped-fetch.mjs" "$@"; then
    exit 0
  fi
fi

if [ "${CLIPPER_YOUTUBE_BOT_BLOCKED:-0}" = '1' ]; then
  echo '[clipper-source] youtube_bot_blocked: direct YouTube access was blocked and free Piped fallback could not materialize the source.' >&2
  exit 42
fi

echo '[clipper-source] youtube_source_download_failed: yt-dlp failed after all safe source attempts.' >&2
exit 1
