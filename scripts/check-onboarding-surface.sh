#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() {
  echo "onboarding surface check failed: $*" >&2
  exit 1
}

if rg -n "npx -y @susurration/installer install --token" README.md docs shared web installer cli mcp-adapter agent-daemon; then
  fail "installer command without @latest"
fi

if rg -n "sk_live_YOUR_TOKEN|sk_xxx|llm_key|--llm-key" README.md docs shared web installer mcp-adapter agent-daemon; then
  fail "stale token or legacy LLM-key onboarding copy"
fi

if rg -n "Use \\\`susu_join\\\` for one-step setup|susu_join.*preferred|For MCP-only setup, the \\\`susu_join\\\` MCP tool handles" README.md docs shared web installer mcp-adapter agent-daemon; then
  fail "susu_join is presented as the primary setup path"
fi

rg -q "susu doctor" README.md || fail "README missing susu doctor"
rg -q "susu doctor" docs/system-overview.md || fail "system overview missing susu doctor"
rg -q "susu doctor" installer/README.md || fail "installer README missing susu doctor"
rg -q "susu doctor" web/public/llms.txt || fail "llms.txt missing susu doctor"
test -f docs/live-bridge-checklist.md || fail "live bridge checklist missing"

echo "onboarding surface check passed"
