#!/usr/bin/env bash
set -uo pipefail

# Wrapper for yt-dlp on shared GitHub-hosted runners. YouTube frequently
# challenges those egress IPs with HTTP 429 / bot checks. Keep the normal
# anonymous path, but support authenticated cookies and/or a stable proxy
# without ever printing either secret.

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

# First preserve the exact renderer request.
if run_attempt default "$@"; then
  exit 0
fi

# A different official player client can occasionally bypass a broken web
# response. It is intentionally only one retry; hammering a challenged GitHub
# IP makes the 429 situation worse.
if run_attempt alternate-client --extractor-args 'youtube:player_client=web_safari,android_vr' "$@"; then
  exit 0
fi

if [ "${CLIPPER_YOUTUBE_BOT_BLOCKED:-0}" = '1' ]; then
  echo '[clipper-source] youtube_bot_blocked: GitHub runner egress was challenged by YouTube. Configure repository secret YOUTUBE_COOKIES_B64 (Netscape cookies.txt encoded as base64) or YOUTUBE_PROXY_URL, then retry the render.' >&2
  exit 42
fi

echo '[clipper-source] youtube_source_download_failed: yt-dlp failed after the safe retry.' >&2
exit 1
