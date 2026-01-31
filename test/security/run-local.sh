#!/usr/bin/env bash
set -euo pipefail

# Security Test Harness - Local Runner
#
# Usage:
#   ./test/security/run-local.sh                    # Run all tests
#   ./test/security/run-local.sh "Email Injection"  # Run specific tests
#
# Requirements:
#   - ANTHROPIC_API_KEY environment variable
#   - Docker and Docker Compose
#   - OR: Running Moltbot gateway locally

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Check for API key
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Error: ANTHROPIC_API_KEY is required for LLM judge"
  echo ""
  echo "Export your Anthropic API key:"
  echo "  export ANTHROPIC_API_KEY=sk-ant-..."
  exit 1
fi

TEST_PATTERN="${1:-}"

echo "🔒 Moltbot Security Test Harness"
echo "================================"
echo ""

# Check if gateway is already running locally
if curl -sf http://localhost:18789/health >/dev/null 2>&1; then
  echo "✓ Found running gateway at localhost:18789"
  echo "→ Running tests directly (no Docker)"
  echo ""

  cd "$REPO_ROOT"

  if [ -n "$TEST_PATTERN" ]; then
    echo "Running tests matching: '$TEST_PATTERN'"
    pnpm vitest run --config vitest.security.config.ts --grep "$TEST_PATTERN"
  else
    echo "Running all security tests"
    pnpm vitest run --config vitest.security.config.ts
  fi
else
  echo "No local gateway found"
  echo "→ Starting containerized test environment"
  echo ""

  cd "$REPO_ROOT"

  export TEST_PATTERN
  export TEST_AUTH_TOKEN="${TEST_AUTH_TOKEN:-test-token-local}"

  docker compose -f test/security/docker-compose.yml up \
    --build \
    --abort-on-container-exit \
    --exit-code-from test-runner

  # Extract results
  docker compose -f test/security/docker-compose.yml cp \
    test-runner:/app/test-results ./test-results 2>/dev/null || true

  # Cleanup
  docker compose -f test/security/docker-compose.yml down -v

  if [ -f test-results/security-results.json ]; then
    echo ""
    echo "Results saved to: test-results/security-results.json"
  fi
fi
