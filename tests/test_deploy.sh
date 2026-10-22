#!/usr/bin/env bash
# Tests for scripts/deploy.sh — deploys CF Workers + Vercel, updates refresh token, runs health+chat tests.
# Usage: bash tests/test_deploy.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/deploy.sh"
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# 1. script exists and is executable
if [ -x "$SCRIPT" ]; then ok "deploy.sh exists and executable"; else bad "deploy.sh exists and executable"; fi

# 2. --help exits 0 and mentions tokens-file, cf-url, vercel-url
if [ -x "$SCRIPT" ] && "$SCRIPT" --help >/tmp/deploy-help.txt 2>&1; then
  if grep -q "tokens-file" /tmp/deploy-help.txt && grep -q "cf-url" /tmp/deploy-help.txt && grep -q "vercel-url" /tmp/deploy-help.txt; then
    ok "--help documents required flags"
  else
    bad "--help documents required flags"
  fi
else
  bad "--help exits 0"
fi

# 3. missing --tokens-file must fail (no deploys attempted)
if [ -x "$SCRIPT" ]; then
  if "$SCRIPT" --cf-url https://cf.example --vercel-url https://vc.example >/tmp/deploy-missing.txt 2>&1; then
    bad "missing --tokens-file fails"
  else
    ok "missing --tokens-file fails"
  fi
fi

# 4. full run with stubbed wrangler/vercel/curl — must succeed, call both deploys + both health checks + both chat tests, and never leak tokens
if [ -x "$SCRIPT" ]; then
  STUB="$ROOT/.tmp-test-bin"
  LOG="$ROOT/.tmp-test-calls.log"
  rm -rf "$STUB" "$LOG"
  mkdir -p "$STUB"
  touch "$LOG"
  printf 'tok-line-1\ntok-line-2\n' > "$ROOT/.tmp-test-tokens.txt"

  # stub: wrangler — log args, accept secret put via stdin redirect
  cat > "$STUB/wrangler" <<'EOF'
#!/usr/bin/env bash
echo "wrangler $*" >> "$TEST_CALL_LOG"
cat > /dev/null
exit 0
EOF
  # stub: vercel — log args, accept env add via stdin redirect
  cat > "$STUB/vercel" <<'EOF'
#!/usr/bin/env bash
echo "vercel $*" >> "$TEST_CALL_LOG"
if [ "${1:-}" = "env" ] && [ "${2:-}" = "add" ]; then cat > /dev/null; fi
exit 0
EOF
  # stub: curl — log URL, return canned ok JSON for health, models and chat
  cat > "$STUB/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$TEST_CALL_LOG"
for a in "$@"; do
  case "$a" in
    */v1/chat/completions) echo '{"choices":[{"message":{"content":"OK"}}]}'; exit 0;;
    */v1/models) echo '{"data":[{"id":"cline-free/nemotron-3.5-super-vl"},{"id":"cline-free/mimo-v2.6-flash"}]}'; exit 0;;
    */v1/health) echo '{"ok":true,"accounts":2,"model":"cline-free/nemotron-3.5-super-vl"}'; exit 0;;
  esac
done
echo '{}'
exit 0
EOF
  chmod +x "$STUB"/wrangler "$STUB"/vercel "$STUB"/curl

  OUT="$ROOT/.tmp-test-out.txt"
  if TEST_CALL_LOG="$LOG" PATH="$STUB:$PATH" "$SCRIPT" \
      --tokens-file "$ROOT/.tmp-test-tokens.txt" \
      --cf-url https://cf.example \
      --vercel-url https://vc.example \
      --api-key test-key-123 >"$OUT" 2>&1; then
    ok "stubbed full run exits 0"
  else
    bad "stubbed full run exits 0 (see $OUT)"
  fi

  for want in "wrangler deploy" "wrangler secret put CLINE_REFRESH_TOKEN" "vercel --prod" "CLINE_REFRESH_TOKEN production" "https://cf.example/v1/health" "https://vc.example/v1/health"; do
    if grep -q "$want" "$LOG" 2>/dev/null; then ok "calls: $want"; else bad "calls: $want"; fi
  done
  if grep -q "chat/completions" "$LOG" 2>/dev/null; then ok "calls: chat completions test"; else bad "calls: chat completions test"; fi
  if grep -q "tok-line-1" "$OUT" 2>/dev/null || grep -q "tok-line-1" "$LOG" 2>/dev/null; then
    bad "tokens never leak into output/log"
  else
    ok "tokens never leak into output/log"
  fi

  # 5. chat test must not hardcode a delisted model id — it resolves from /v1/models
  if grep -q "cline-free/nemotron-3.5-super-vl" "$LOG" 2>/dev/null; then
    ok "chat test resolves model from /v1/models"
  else
    bad "chat test resolves model from /v1/models"
  fi

  # 6. --model overrides the resolved model
  rm -f "$LOG"; touch "$LOG"
  OUT2="$ROOT/.tmp-test-out2.txt"
  if TEST_CALL_LOG="$LOG" PATH="$STUB:$PATH" "$SCRIPT" \
      --tokens-file "$ROOT/.tmp-test-tokens.txt" \
      --cf-url https://cf.example \
      --vercel-url https://vc.example \
      --api-key test-key-123 \
      --model "cline-free/explicit-model" >"$OUT2" 2>&1; then
    if grep -q "cline-free/explicit-model" "$LOG" 2>/dev/null; then
      ok "--model overrides resolved model"
    else
      bad "--model overrides resolved model"
    fi
  else
    bad "--model run exits 0"
  fi

  rm -rf "$STUB" "$LOG" "$OUT" "$OUT2" "$ROOT/.tmp-test-tokens.txt" /tmp/deploy-help.txt /tmp/deploy-missing.txt
fi

echo "---"
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
