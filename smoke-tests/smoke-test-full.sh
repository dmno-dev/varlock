#!/usr/bin/env bash

# Full smoke test suite for varlock
# Runs all tests including framework integrations (Astro, Next.js)
# This mirrors what the GitHub Actions workflow does

set -e  # Exit on error

echo "🧪 Running FULL varlock smoke test suite..."
echo "This will test CLI, redaction, and framework integrations"
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

test_passed() {
  echo -e "${GREEN}✓${NC} $1"
}

test_failed() {
  echo -e "${RED}✗${NC} $1"
  exit 1
}

test_section() {
  echo ""
  echo -e "${BLUE}▶ $1${NC}"
}

# Get the repo root and smoke tests directory
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_TESTS_DIR="$REPO_ROOT/smoke-tests"
cd "$SMOKE_TESTS_DIR"

# =============================================================================
# Build everything first
# =============================================================================
test_section "Building varlock and integrations"
cd "$REPO_ROOT"
pnpm run build:libs || test_failed "Failed to build"
test_passed "Built varlock and integrations"
cd "$SMOKE_TESTS_DIR"

# =============================================================================
# TEST 1: varlock load command
# =============================================================================
test_section "TEST 1: varlock load command"
cd smoke-test-basic
pnpm exec varlock load > /dev/null || test_failed "varlock load failed"
test_passed "varlock load succeeded"
cd "$SMOKE_TESTS_DIR"

# =============================================================================
# TEST 2: varlock run with log redaction
# =============================================================================
test_section "TEST 2: varlock run with log redaction"
cd smoke-test-basic
chmod +x test-script.js || true

# Capture output
pnpm exec varlock run -- node test-script.js > /tmp/output.txt 2>&1 || true

# Verify env vars are loaded
if ! grep -q "NODE_ENV: test" /tmp/output.txt; then
  echo "❌ NODE_ENV not loaded correctly"
  cat /tmp/output.txt
  exit 1
fi

if ! grep -q "PUBLIC_VAR: public-value" /tmp/output.txt; then
  echo "❌ PUBLIC_VAR not loaded correctly"
  cat /tmp/output.txt
  exit 1
fi

# Verify secret is redacted
if grep -q "super-secret-token-12345" /tmp/output.txt; then
  echo "❌ SECRET_TOKEN was NOT redacted!"
  cat /tmp/output.txt
  exit 1
fi

# Check for redaction markers
if ! grep -q "▒▒▒▒▒" /tmp/output.txt; then
  echo -e "${YELLOW}⚠️  Warning: No redaction markers found (may be OK on some platforms)${NC}"
else
  test_passed "Secrets are properly redacted"
fi

# Verify success message
if ! grep -q "All env vars loaded correctly" /tmp/output.txt; then
  echo "❌ Test script did not complete successfully"
  cat /tmp/output.txt
  exit 1
fi

rm -f /tmp/output.txt
test_passed "varlock run with redaction succeeded"
cd "$SMOKE_TESTS_DIR"

# =============================================================================
# TEST 3: varlock run with interactive script redaction
# =============================================================================
test_section "TEST 3: Interactive script redaction"
cd smoke-test-basic
chmod +x interactive-script.js || true

pnpm exec varlock run -- node interactive-script.js > /tmp/interactive-output.txt 2>&1 || true

# Verify script completed
if ! grep -q "Interactive script completed successfully" /tmp/interactive-output.txt; then
  echo "❌ Interactive script did not complete successfully"
  cat /tmp/interactive-output.txt
  exit 1
fi

# Verify secret is redacted
if grep -q "super-secret-token-12345" /tmp/interactive-output.txt; then
  echo "❌ SECRET_TOKEN was NOT redacted in interactive output!"
  cat /tmp/interactive-output.txt
  exit 1
fi

# Verify public vars still work
if ! grep -q "PUBLIC_VAR: public-value" /tmp/interactive-output.txt; then
  echo "❌ PUBLIC_VAR not visible in interactive output"
  cat /tmp/interactive-output.txt
  exit 1
fi

rm -f /tmp/interactive-output.txt
test_passed "Interactive script redaction succeeded"
cd "$SMOKE_TESTS_DIR"

# =============================================================================
# TEST 4: Stdin availability test
# =============================================================================
test_section "TEST 4: Stdin availability test"
cd smoke-test-basic
chmod +x stdin-test.js || true

pnpm exec varlock run -- node stdin-test.js > /tmp/stdin-output.txt 2>&1

# Verify test completed
if ! grep -q "Stdin test completed" /tmp/stdin-output.txt; then
  echo "❌ Stdin test did not complete successfully"
  cat /tmp/stdin-output.txt
  exit 1
fi

# Verify stdin properties are accessible
if ! grep -q "stdin.isTTY" /tmp/stdin-output.txt; then
  echo "❌ stdin.isTTY property not accessible"
  cat /tmp/stdin-output.txt
  exit 1
fi

if ! grep -q "stdin.readable" /tmp/stdin-output.txt; then
  echo "❌ stdin.readable property not accessible"
  cat /tmp/stdin-output.txt
  exit 1
fi

# Verify secrets still redacted
if grep -q "super-secret-token-12345" /tmp/stdin-output.txt; then
  echo "❌ SECRET_TOKEN was NOT redacted in stdin test!"
  cat /tmp/stdin-output.txt
  exit 1
fi

rm -f /tmp/stdin-output.txt
test_passed "Stdin availability test passed"
cd "$SMOKE_TESTS_DIR"

# =============================================================================
# TEST 5: varlock run with Bun (if available)
# =============================================================================
if command -v bun &> /dev/null; then
  test_section "TEST 5: varlock run with Bun"
  cd smoke-test-basic

  pnpm exec varlock run -- bun test-script.js > /tmp/bun-output.txt 2>&1 || true

  # Verify env vars are loaded
  if ! grep -q "NODE_ENV: test" /tmp/bun-output.txt; then
    echo "❌ NODE_ENV not loaded correctly with Bun"
    cat /tmp/bun-output.txt
    exit 1
  fi

  # Verify secret is redacted
  if grep -q "super-secret-token-12345" /tmp/bun-output.txt; then
    echo "❌ SECRET_TOKEN was NOT redacted with Bun!"
    cat /tmp/bun-output.txt
    exit 1
  fi

  # Verify success message
  if ! grep -q "All env vars loaded correctly" /tmp/bun-output.txt; then
    echo "❌ Test script did not complete successfully with Bun"
    cat /tmp/bun-output.txt
    exit 1
  fi

  rm -f /tmp/bun-output.txt
  test_passed "varlock run with Bun succeeded"
  cd "$SMOKE_TESTS_DIR"
else
  echo -e "${YELLOW}⊘ Skipping Bun test (bun not installed)${NC}"
fi

# =============================================================================
# TEST 6: Astro integration
# =============================================================================
test_section "TEST 6: Astro integration"
cd smoke-test-astro
# Unset cached env to ensure it loads from the smoke test directory
unset __VARLOCK_ENV
pnpm install --silent || test_failed "Failed to install Astro dependencies"
pnpm exec varlock load > /dev/null || test_failed "Failed to generate types for Astro"
pnpm run build || test_failed "Astro build failed"

# Verify build output
if [ ! -f "dist/index.html" ]; then
  echo "❌ Astro build did not produce output"
  exit 1
fi

# Check that env vars were injected into build
if ! grep -q "api.example.com" dist/index.html; then
  echo "❌ PUBLIC_API_URL not injected into Astro build"
  cat dist/index.html
  exit 1
fi

# Verify secret is accessible at build time but not leaked
if ! grep -q "Secret accessible on server: Yes" dist/index.html; then
  echo "❌ SECRET_API_KEY not accessible during Astro build"
  cat dist/index.html
  exit 1
fi

if grep -q "test-api-key-secret-123" dist/index.html; then
  echo "❌ SECRET_API_KEY value leaked into Astro build!"
  cat dist/index.html
  exit 1
fi

# Verify empty secret is correctly handled
if ! grep -q "Empty secret is empty: Yes" dist/index.html; then
  echo "❌ Empty secret not handled correctly in Astro build"
  cat dist/index.html
  exit 1
fi

if ! grep -q "Build succeeded with varlock integration" dist/index.html; then
  echo "❌ Astro page did not render correctly"
  cat dist/index.html
  exit 1
fi

test_passed "Astro integration succeeded"
cd "$SMOKE_TESTS_DIR"

# =============================================================================
# TEST 7: Next.js integration
# =============================================================================
test_section "TEST 7: Next.js integration"
cd smoke-test-nextjs
# Unset cached env to ensure it loads from the smoke test directory
unset __VARLOCK_ENV
pnpm install --silent || test_failed "Failed to install Next.js dependencies"
pnpm exec varlock load > /dev/null || test_failed "Failed to generate types for Next.js"
pnpm run build || test_failed "Next.js build failed"

# Verify build output
if [ ! -d "out" ]; then
  echo "❌ Next.js build did not produce output"
  exit 1
fi

# Check that the build succeeded
if [ ! -f "out/index.html" ]; then
  echo "❌ Next.js did not generate index.html"
  exit 1
fi

# Check that env vars were injected
if ! grep -q "api.example.com" out/index.html; then
  echo "❌ NEXT_PUBLIC_API_URL not injected into Next.js build"
  cat out/index.html
  exit 1
fi

if ! grep -q "Build succeeded with varlock integration" out/index.html; then
  echo "❌ Next.js page did not render correctly"
  cat out/index.html
  exit 1
fi

test_passed "Next.js integration succeeded"
cd "$SMOKE_TESTS_DIR"

# =============================================================================
# TEST 8: Command not found error handling
# =============================================================================
test_section "TEST 8: Command not found error handling"
cd smoke-test-basic

pnpm exec varlock run -- nonexistent-command-xyz 2>&1 | tee /tmp/cmd-error.txt > /dev/null || true

if grep -qi "command\|not found\|ENOENT" /tmp/cmd-error.txt; then
  test_passed "Command not found error handled correctly"
else
  echo "❌ Expected command not found error"
  cat /tmp/cmd-error.txt
  exit 1
fi

rm -f /tmp/cmd-error.txt
cd "$SMOKE_TESTS_DIR"

# =============================================================================
# TEST 9: Platform-specific executable tests
# =============================================================================
if [[ "$OSTYPE" != "msys" && "$OSTYPE" != "win32" ]]; then
  test_section "TEST 9: Script execution (Unix)"
  cd smoke-test-basic

  echo '#!/usr/bin/env node' > /tmp/shebang-test.js
  echo 'console.log("Shebang script works");' >> /tmp/shebang-test.js
  chmod +x /tmp/shebang-test.js

  pnpm exec varlock run -- /tmp/shebang-test.js | tee /tmp/shebang-output.txt > /dev/null

  if ! grep -q "Shebang script works" /tmp/shebang-output.txt; then
    echo "❌ Shebang script did not execute"
    cat /tmp/shebang-output.txt
    exit 1
  fi

  rm -f /tmp/shebang-test.js /tmp/shebang-output.txt
  test_passed "Shebang script execution succeeded"
  cd "$SMOKE_TESTS_DIR"
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "======================================"
echo -e "${GREEN}✅ All smoke tests passed!${NC}"
echo "Platform: $(uname -s)"
echo "Node version: $(node --version)"
if command -v bun &> /dev/null; then
  echo "Bun version: $(bun --version)"
fi
echo "======================================"
