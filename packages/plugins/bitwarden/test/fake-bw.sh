#!/bin/sh
# Fake `bw` CLI for integration tests.
# Reads canned responses from bw-config.json next to this script.
#
# Every `unlock` invocation records itself by creating a uniquely-named file under
# `<dir>/unlocks/` (pid + high-res time, so concurrent processes never collide).
# Tests count those files to assert how many real unlocks happened — this is how we
# verify that concurrent re-unlocks are deduped into a single `bw unlock`.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/bw-config.json"
UNLOCKS_DIR="$SCRIPT_DIR/unlocks"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "fake bw: config file not found ($CONFIG_FILE)" >&2
  exit 1
fi

case "$1" in
  unlock)
    # bw unlock --raw [--passwordenv BW_VARLOCK_MASTERPW]
    node -e "
      const fs = require('fs');
      const path = require('path');
      const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf-8'));
      // record this unlock invocation (unique filename — no cross-process races)
      fs.mkdirSync('$UNLOCKS_DIR', { recursive: true });
      fs.writeFileSync(path.join('$UNLOCKS_DIR', process.pid + '-' + process.hrtime.bigint()), '');
      if (cfg.unlockError) { process.stderr.write(cfg.unlockError); process.exit(1); }
      // real \`bw unlock\` issues a fresh key each time; emit a unique token unless the
      // test pins one explicitly, so re-unlock logic that compares tokens is exercised
      process.stdout.write(cfg.sessionToken || ('fake-session-' + process.pid + '-' + process.hrtime.bigint()));
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
      // simulate a vault that stays locked until a *second* unlock has happened.
      // unlike the marker above, this is keyed on the unlock count, so it holds even
      // when several gets run concurrently (used to test re-unlock dedup).
      if (cfg.staleFirstSession) {
        let unlockCount = 0;
        try { unlockCount = fs.readdirSync('$UNLOCKS_DIR').length; } catch {}
        if (unlockCount < 2) {
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
