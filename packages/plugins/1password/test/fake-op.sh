#!/bin/sh
# Fake op CLI for integration tests.
# Reads config from op-config.json next to this script.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/op-config.json"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "[ERROR] fake op: config file not found ($CONFIG_FILE)" >&2
  exit 1
fi

case "$1" in
  whoami)
    echo "Test User <test@example.com>"
    ;;
  run)
    # op run --no-masking [--account X] -- env -0
    # Reads VARLOCK_1P_INJECT_* env vars, resolves op:// references from config,
    # and outputs null-separated KEY=value pairs (like `env -0`).
    node -e "
      const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf-8'));
      const responses = cfg.responses || {};
      const errors = cfg.errors || {};
      const refs = [];

      for (const [key, ref] of Object.entries(process.env)) {
        if (!key.startsWith('VARLOCK_1P_INJECT_')) continue;
        refs.push({ key, ref });
      }

      // Check for errors first (real op fails entire batch on first error)
      for (const { ref } of refs) {
        if (errors[ref]) {
          process.stderr.write('[ERROR] 2024/01/01 00:00:00 ' + errors[ref] + '\n');
          process.exit(1);
        }
      }

      // Output resolved values as null-separated pairs
      const results = [];
      for (const { key, ref } of refs) {
        if (ref in responses) {
          results.push(key + '=' + responses[ref]);
        }
      }
      process.stdout.write(results.join('\0') + '\0');
    "
    ;;
  environment)
    # op environment read <envId> [--account X]
    ENV_ID="$3"
    node -e "
      const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf-8'));
      const environments = cfg.environments || {};
      const envId = '$ENV_ID';
      if (envId in environments) {
        process.stdout.write(environments[envId]);
      } else {
        process.stderr.write('[ERROR] 2024/01/01 00:00:00 environment not found or invalid\n');
        process.exit(1);
      }
    "
    ;;
  *)
    echo "[ERROR] fake op: unknown subcommand $1" >&2
    exit 1
    ;;
esac
