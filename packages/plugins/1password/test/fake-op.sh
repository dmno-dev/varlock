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
    # op inject -i <template-file> [--account X]
    # Resolves {{ op://... }} references from config and prints the substituted
    # template. Mimics real op inject behavior: requires the template to come
    # from a file, fails the whole batch on the first bad reference, strips
    # control characters (except \t \n \v \f \r) from output, and appends a
    # trailing newline.
    #
    # Real `op inject` only accepts stdin when it is a true pipe (it checks for
    # os.ModeNamedPipe), and node/bun hand spawned children a socketpair, so a
    # template written to the child's stdin is never seen. Reject that here so
    # tests fail the same way real op does instead of silently passing.
    TEMPLATE_FILE=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -i) TEMPLATE_FILE="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [ -z "$TEMPLATE_FILE" ]; then
      echo "[ERROR] 2024/01/01 00:00:00 expected data on stdin but none found" >&2
      exit 1
    fi
    node -e "
      const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf-8'));
      const responses = cfg.responses || {};
      const errors = cfg.errors || {};
      const template = require('fs').readFileSync('$TEMPLATE_FILE', 'utf-8');

      // refs listed in omit are dropped from the output entirely, to simulate op exiting 0
      // without printing a requested ref
      const omit = cfg.omit || [];
      if (cfg.emptyOutput) process.exit(0);

      const refs = [...template.matchAll(/\{\{\s*(op:\/\/[^}]+?)\s*\}\}/g)].map((m) => m[1]);

      // Check for errors first (real op fails entire batch on first error)
      for (const ref of refs) {
        if (errors[ref]) {
          process.stderr.write('[ERROR] 2024/01/01 00:00:00 ' + errors[ref] + '\n');
          process.exit(1);
        }
      }

      const keptTemplate = template
        .split(/(?<=__VARLOCK_1P_SEP_[0-9a-f-]+__)/)
        .filter((seg) => !omit.some((ref) => seg.includes('{{ ' + ref + ' }}')))
        .join('');
      const output = keptTemplate.replace(/\{\{\s*(op:\/\/[^}]+?)\s*\}\}/g, (match, ref) => {
        return ref in responses ? responses[ref] : match;
      });
      process.stdout.write(output.replace(/[\x00-\x08\x0e-\x1f\x7f]/g, '') + '\n');
    "
    ;;
  run)
    # op run --environment <envId> [--env-file F] [--account X] [--no-masking] -- <command...>
    # Mimics real op run: inherited op:// references are resolved (an unknown one fails the run),
    # and precedence is Environment over --env-file over the inherited env.
    shift
    ENV_ID=""
    ENV_FILE=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --environment) ENV_ID="$2"; shift 2 ;;
        --env-file) ENV_FILE="$2"; shift 2 ;;
        --account) shift 2 ;;
        --) shift; break ;;
        *) shift ;;
      esac
    done
    node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf-8'));
      const environments = cfg.environments || {};
      const responses = cfg.responses || {};
      const envId = '$ENV_ID';
      if (!(envId in environments)) {
        process.stderr.write('[ERROR] 2024/01/01 00:00:00 environment not found or invalid\n');
        process.exit(1);
      }
      const parseEnvLines = (raw) => raw.split('\n').flatMap((line) => {
        const eqPos = line.indexOf('=');
        return eqPos > 0 ? [[line.substring(0, eqPos), line.substring(eqPos + 1)]] : [];
      });
      const env = { ...process.env };
      for (const [key, value] of Object.entries(env)) {
        if (!value.startsWith('op://')) continue;
        if (!(value in responses)) {
          process.stderr.write('[ERROR] 2024/01/01 00:00:00 could not resolve secret reference ' + value + '\n');
          process.exit(1);
        }
        env[key] = responses[value];
      }
      if ('$ENV_FILE') for (const [key, value] of parseEnvLines(fs.readFileSync('$ENV_FILE', 'utf-8'))) env[key] = value;
      for (const [key, value] of parseEnvLines(environments[envId])) env[key] = value;
      const [cmd, ...args] = process.argv.slice(1);
      const child = require('child_process').spawnSync(cmd, args, { env, stdio: 'inherit' });
      process.exit(child.status ?? 1);
    " "$@"
    ;;
  environment)
    # op environment read <envId> [--account X]
    # Stable op releases only offer `op run --environment`.
    ENV_ID="$3"
    node -e "
      const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf-8'));
      if (cfg.stableCli) {
        process.stderr.write('[ERROR] 2024/01/01 00:00:00 unknown command \"environment\" for \"op\"\n');
        process.exit(1);
      }
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
