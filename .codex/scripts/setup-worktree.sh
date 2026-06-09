#!/usr/bin/env bash
set -euo pipefail

bun install
bun run build:libs
