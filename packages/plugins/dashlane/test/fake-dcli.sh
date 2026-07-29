#!/bin/sh
# Fake dcli script for integration tests.
# Reads expected responses from a JSON config file whose path is passed
# via the FAKE_DCLI_CONFIG environment variable.

CONFIG_FILE="${FAKE_DCLI_CONFIG}"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "dcli fake: config file not found ($CONFIG_FILE)" >&2
  exit 1
fi

SUBCMD="$1"
shift

case "$SUBCMD" in
  --version)
    echo "6.2453.0"
    ;;
  sync)
    echo ""
    ;;
  lock)
    echo ""
    ;;
  read)
    REF="$1"

    # Optional misbehavior modes (cfg.readBehavior) used by locked-vault tests
    BEHAVIOR=$(node -e "
      const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf-8'));
      process.stdout.write(cfg.readBehavior || 'normal');
    ")
    case "$BEHAVIOR" in
      hang)
        # simulate dcli stalling forever (must be killed by the plugin's timeout)
        sleep 30
        exit 1
        ;;
      prompt-stdin)
        # simulate dcli prompting for the master password on a locked vault:
        # blocks reading stdin, so it hangs forever unless stdin is closed
        printf '? Please enter your master password\n' >&2
        if read -r _MASTER_PW; then
          echo "unlocked-with-$_MASTER_PW"
          exit 0
        else
          printf 'Vault is locked\n' >&2
          exit 1
        fi
        ;;
      locked)
        printf 'Vault is locked, please run dcli sync\n' >&2
        exit 1
        ;;
    esac

    # Use node to look up the reference in the JSON config (portable JSON parsing)
    node -e "
      const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf-8'));
      const ref = '$REF';
      if (ref in cfg.responses) {
        process.stdout.write(cfg.responses[ref] + '\n');
      } else {
        process.stderr.write('No matching item found for ' + ref);
        process.exit(1);
      }
    "
    ;;
  *)
    echo "dcli fake: unknown subcommand $SUBCMD" >&2
    exit 1
    ;;
esac
