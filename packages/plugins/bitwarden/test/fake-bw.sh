#!/bin/sh
# Fake `bw` CLI for integration tests.
# Reads canned responses from bw-config.json next to this script.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/bw-config.json"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "fake bw: config file not found ($CONFIG_FILE)" >&2
  exit 1
fi

case "$1" in
  unlock)
    # bw unlock --raw [--passwordenv BW_VARLOCK_MASTERPW]
    node -e "
      const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf-8'));
      if (cfg.unlockError) { process.stderr.write(cfg.unlockError); process.exit(1); }
      process.stdout.write(cfg.sessionToken || 'fake-session-token');
    "
    ;;
  get)
    # bw get item <query> --nointeraction
    QUERY="$3"
    node -e "
      const fs = require('fs');
      const cfgPath = '$CONFIG_FILE';
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      const items = cfg.items || {};
      const query = process.argv[1];
      // simulate a stale/locked session for the first get, then succeed (after a re-unlock)
      if (cfg.lockedUntilReunlock) {
        const marker = cfgPath + '.unlocked';
        if (!fs.existsSync(marker)) {
          fs.writeFileSync(marker, '1');
          process.stderr.write('Vault is locked.');
          process.exit(1);
        }
      }
      if (Object.prototype.hasOwnProperty.call(items, query)) {
        process.stdout.write(JSON.stringify(items[query]));
      } else {
        process.stderr.write('Not found.');
        process.exit(1);
      }
    " "$QUERY"
    ;;
  *)
    echo "fake bw: unknown subcommand $1" >&2
    exit 1
    ;;
esac
