#!/usr/bin/env bash

# Local smoke test script for varlock
# This runs basic smoke tests that should pass on the current platform
# For full cross-platform testing, see .github/workflows/smoke-test.yaml

set -e  # Exit on error

echo "🧪 Running varlock smoke tests..."
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

test_passed() {
  echo -e "${GREEN}✓${NC} $1"
}

test_failed() {
  echo -e "${RED}✗${NC} $1"
  exit 1
}

test_section() {
  echo -e "${BLUE}▶${NC} $1"
}

# Get the repo root
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Path to the built varlock CLI
VARLOCK_CLI="$REPO_ROOT/packages/varlock/bin/cli.js"

echo "Note: This script assumes varlock has already been built (run 'pnpm build:libs' first)"
echo ""

# Test 1: CLI help
test_section "Test 1: Testing CLI help command"
"$VARLOCK_CLI" --help > /dev/null || test_failed "CLI help command failed"
test_passed "CLI help works"

# Test 2: Create temp directory for tests
TEST_DIR=$(mktemp -d)
trap "rm -rf $TEST_DIR" EXIT
cd "$TEST_DIR"

# Create a minimal .env file
cat > .env <<EOF
TEST_VAR="hello world"
NODE_ENV="test"
EOF

test_section "Test 3: Testing varlock run with node"
"$VARLOCK_CLI" run -- node --version > /dev/null || test_failed "varlock run failed"
test_passed "varlock run works"

# Test 4: Test with Bun (if available)
if command -v bun &> /dev/null; then
  test_section "Test 4: Testing varlock run with bun"
  "$VARLOCK_CLI" run -- bun --version > /dev/null || test_failed "varlock run with bun failed"
  test_passed "varlock run with bun works"
else
  echo "  ⊘ Skipping bun test (bun not installed)"
fi

# Test 5: Test interactive script redaction
test_section "Test 5: Testing interactive script redaction"
cd "$REPO_ROOT/smoke-tests/smoke-test-basic"
chmod +x interactive-script.js 2>/dev/null || true

# Run the interactive script and capture output
if "$VARLOCK_CLI" run -- node interactive-script.js > /tmp/interactive-test.txt 2>&1; then
  # Check that the secret is redacted (not present in plain text)
  if grep -q "super-secret-token-12345" /tmp/interactive-test.txt; then
    test_failed "Interactive script: SECRET_TOKEN was NOT redacted!"
  else
    test_passed "Interactive script redaction works"
  fi
else
  test_failed "Interactive script execution failed"
fi
rm -f /tmp/interactive-test.txt

# Test 6: Test stdin availability
test_section "Test 6: Testing stdin availability with redaction"
cd "$REPO_ROOT/smoke-tests/smoke-test-basic"
chmod +x stdin-test.js 2>/dev/null || true

if "$VARLOCK_CLI" run -- node stdin-test.js > /tmp/stdin-test.txt 2>&1; then
  # Check that stdin properties were accessible
  if grep -q "stdin.isTTY" /tmp/stdin-test.txt && grep -q "stdin.readable" /tmp/stdin-test.txt; then
    test_passed "Stdin availability preserved with redaction"
  else
    test_failed "Stdin properties not accessible"
  fi
else
  test_failed "Stdin test script execution failed"
fi
rm -f /tmp/stdin-test.txt
cd "$TEST_DIR"

# Test 7: Test command not found
test_section "Test 7: Testing command not found error"
if "$VARLOCK_CLI" run -- nonexistent-command-xyz 2>&1 | grep -qi "command\|not found\|ENOENT"; then
  test_passed "Command not found error handled correctly"
else
  test_failed "Command not found error not detected"
fi

# Test 8: Test executable script (Unix only)
if [[ "$OSTYPE" != "msys" && "$OSTYPE" != "win32" ]]; then
  test_section "Test 8: Testing script execution"
  cat > test-script.js <<EOF
#!/usr/bin/env node
console.log('Script executed');
EOF
  chmod +x test-script.js
  "$VARLOCK_CLI" run -- ./test-script.js > /dev/null || test_failed "Script execution failed"
  test_passed "Script execution works"
fi

# Test 9: Verify build artifacts exist
test_section "Test 9: Verifying build artifacts"
[ -f "$REPO_ROOT/packages/varlock/dist/index.js" ] || test_failed "Missing varlock dist/index.js"
[ -f "$REPO_ROOT/packages/integrations/vite/dist/index.js" ] || test_failed "Missing vite integration dist/index.js"
[ -f "$REPO_ROOT/packages/integrations/astro/dist/index.js" ] || test_failed "Missing astro integration dist/index.js"
test_passed "All build artifacts present"

# Summary
echo ""
echo -e "${GREEN}✓ All smoke tests passed!${NC}"
echo ""
echo "Note: This script only tests the current platform."
echo "For full cross-platform testing, push to a release PR to trigger"
echo "the GitHub Actions workflow: .github/workflows/smoke-test.yaml"
