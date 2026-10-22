#!/usr/bin/env bash
# Deploy both targets, refresh CLINE_REFRESH_TOKEN, and test.
#
# Usage:
#   scripts/deploy.sh --tokens-file TOKENS --cf-url CF_URL --vercel-url VERCEL_URL [--api-key KEY]
#                     [--model MODEL] [--skip-cf] [--skip-vercel] [--skip-test]
#
#   TOKENS: file with one refreshToken per line (real newlines, never committed).
#   CF_URL / VERCEL_URL: base URLs without trailing slash.
#   API_KEY falls back to $API_KEY env var (chat test is skipped if empty).
#   MODEL: model id used by the chat smoke test. Falls back to $MODEL env var,
#          then to the worker's current default. Cline delists free models
#          periodically, so keep it overridable.
#
# Steps: wrangler deploy + secret put (CF), vercel env rm/add + vercel --prod,
# then GET /v1/health and POST /v1/chat/completions on both URLs.
# Tokens are only ever redirected via stdin, never printed or passed as args.
set -euo pipefail

TOKENS_FILE=""
CF_URL="${CF_URL:-}"
VERCEL_URL="${VERCEL_URL:-}"
API_KEY="${API_KEY:-}"
MODEL="${MODEL:-}"
SKIP_CF=0
SKIP_VERCEL=0
SKIP_TEST=0
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

usage() {
  sed -n '2,/^# Tokens are only/p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tokens-file) TOKENS_FILE="${2:-}"; shift 2 ;;
    --cf-url) CF_URL="${2:-}"; shift 2 ;;
    --vercel-url) VERCEL_URL="${2:-}"; shift 2 ;;
    --api-key) API_KEY="${2:-}"; shift 2 ;;
    --model) MODEL="${2:-}"; shift 2 ;;
    --skip-cf) SKIP_CF=1; shift ;;
    --skip-vercel) SKIP_VERCEL=1; shift ;;
    --skip-test) SKIP_TEST=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $1" >&2; exit 1; }

[ -n "$TOKENS_FILE" ] || die "missing --tokens-file (file with one refreshToken per line)"
[ -f "$TOKENS_FILE" ] || die "tokens file not found: $TOKENS_FILE"
[ -s "$TOKENS_FILE" ] || die "tokens file is empty: $TOKENS_FILE"
if [ "$SKIP_CF" -eq 0 ] && [ -z "$CF_URL" ]; then die "missing --cf-url (or CF_URL env)"; fi
if [ "$SKIP_VERCEL" -eq 0 ] && [ -z "$VERCEL_URL" ]; then die "missing --vercel-url (or VERCEL_URL env)"; fi
command -v wrangler >/dev/null 2>&1 || { [ "$SKIP_CF" -eq 1 ] || die "wrangler not found (npm i -g wrangler)"; }
command -v vercel >/dev/null 2>&1 || { [ "$SKIP_VERCEL" -eq 1 ] || die "vercel CLI not found (npm i -g vercel)"; }
command -v curl >/dev/null 2>&1 || { [ "$SKIP_TEST" -eq 1 ] || die "curl not found"; }

CF_URL="$(printf '%s' "$CF_URL" | sed 's:/*$::')"
VERCEL_URL="$(printf '%s' "$VERCEL_URL" | sed 's:/*$::')"

if [ "$SKIP_CF" -eq 0 ]; then
  echo "==> Cloudflare: wrangler deploy"
  wrangler deploy
  echo "==> Cloudflare: updating secret CLINE_REFRESH_TOKEN"
  wrangler secret put CLINE_REFRESH_TOKEN < "$TOKENS_FILE"
  if [ -n "$API_KEY" ]; then
    printf '%s' "$API_KEY" | wrangler secret put API_KEY
  fi
  echo "CF done."
fi

if [ "$SKIP_VERCEL" -eq 0 ]; then
  echo "==> Vercel: updating env CLINE_REFRESH_TOKEN"
  vercel env rm CLINE_REFRESH_TOKEN production -y >/dev/null 2>&1 || true
  vercel env add CLINE_REFRESH_TOKEN production < "$TOKENS_FILE"
  if [ -n "$API_KEY" ]; then
    vercel env rm API_KEY production -y >/dev/null 2>&1 || true
    printf '%s' "$API_KEY" | vercel env add API_KEY production
  fi
  echo "==> Vercel: vercel --prod"
  vercel --prod
  echo "Vercel done."
fi

check_health() {
  url="$1/v1/health"
  echo "==> Health: $url"
  body="$(curl -fsS -A "$UA" "$url")"
  echo "$body"
  echo "$body" | grep -q '"ok":true' || { echo "Health FAILED: $url -> $body" >&2; return 1; }
  echo "Health OK: $url"
}

# Resolve the model id for the chat smoke test.
# Order: --model/$MODEL env > first cline-free/* id from GET /v1/models > worker's
# own default (reported by /v1/health). Cline delists free models periodically,
# so a hardcoded id silently breaks the smoke test.
resolve_model() {
  base="$1"
  if [ -n "$MODEL" ]; then
    echo "$MODEL"
    return 0
  fi
  models="$(curl -fsS -A "$UA" "$base/v1/models" 2>/dev/null || true)"
  picked="$(printf '%s' "$models" \
    | grep -o '"id"[[:space:]]*:[[:space:]]*"cline-free/[^"]*"' \
    | head -1 \
    | sed 's/.*"cline-free\/\([^"]*\)".*/cline-free\/\1/')"
  if [ -n "$picked" ]; then
    echo "$picked"
    return 0
  fi
  # Fall back to whatever the worker reports as its default.
  curl -fsS -A "$UA" "$base/v1/health" 2>/dev/null \
    | grep -o '"model"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 \
    | sed 's/.*"\([^"]*\)"$/\1/' || true
}

check_chat() {
  base="$1"
  [ -n "$API_KEY" ] || { echo "skip chat test (no API key): $base"; return 0; }
  model="$(resolve_model "$base")"
  [ -n "$model" ] || { echo "skip chat test (no model resolved): $base"; return 0; }
  echo "==> Chat: $base/v1/chat/completions (model=$model)"
  body="$(curl -fsS -A "$UA" "$base/v1/chat/completions" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with OK\"}],\"stream\":false}")"
  echo "$body" | grep -q 'choices' || { echo "Chat FAILED: $base -> $body" >&2; return 1; }
  echo "Chat OK: $base"
}

if [ "$SKIP_TEST" -eq 0 ]; then
  if [ "$SKIP_CF" -eq 0 ]; then check_health "$CF_URL"; check_chat "$CF_URL"; fi
  if [ "$SKIP_VERCEL" -eq 0 ]; then check_health "$VERCEL_URL"; check_chat "$VERCEL_URL"; fi
fi

echo "ALL DONE"
