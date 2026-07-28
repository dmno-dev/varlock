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
  inject)
    # op inject [--account X]
    # Reads a template from stdin, resolves {{ op://... }} references from
    # config, and prints the substituted template. Mimics real op inject
    # behavior: fails the whole batch on the first bad reference, strips
    # control characters (except newline/tab) from output, and appends a
    # trailing newline.
    node -e "
      const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf-8'));
      const responses = cfg.responses || {};
      const errors = cfg.errors || {};
      const template = require('fs').readFileSync(0, 'utf-8');

      const refs = [...template.matchAll(/\{\{\s*(op:\/\/[^}]+?)\s*\}\}/g)].map((m) => m[1]);

      // Check for errors first (real op fails entire batch on first error)
      for (const ref of refs) {
        if (errors[ref]) {
          process.stderr.write('[ERROR] 2024/01/01 00:00:00 ' + errors[ref] + '\n');
          process.exit(1);
        }
      }

      const output = template.replace(/\{\{\s*(op:\/\/[^}]+?)\s*\}\}/g, (match, ref) => {
        return ref in responses ? responses[ref] : match;
      });
      process.stdout.write(output.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') + '\n');
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
