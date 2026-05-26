#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
STAMP_FILE="${REPO_ROOT}/.codex/.last-setup-run"
LOG_FILE="${REPO_ROOT}/.codex/.setup-worktree.log"
RUN_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

write_stamp() {
  local status="$1"
  cat > "${STAMP_FILE}" <<EOF
run_at=${RUN_AT}
status=${status}
repo_root=${REPO_ROOT}
pid=$$
EOF
}

mkdir -p "${REPO_ROOT}/.codex"
write_stamp "running"
echo "[setup-worktree] start ${RUN_AT} (repo: ${REPO_ROOT})" | tee -a "${LOG_FILE}"

trap 'write_stamp "failed"; echo "[setup-worktree] failed" | tee -a "${LOG_FILE}"' ERR

cd "${REPO_ROOT}"
bun install 2>&1 | tee -a "${LOG_FILE}"
bun run build:libs 2>&1 | tee -a "${LOG_FILE}"

write_stamp "ok"
echo "[setup-worktree] completed" | tee -a "${LOG_FILE}"
