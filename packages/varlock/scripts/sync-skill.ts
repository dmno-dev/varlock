/**
 * Copies the canonical agent skill from the repo root (`skills/`) into this
 * package so it ships inside the published npm tarball. The skill then travels
 * with the installed varlock version, letting agents discover version-pinned
 * guidance straight from `node_modules` (no separate install / registry).
 *
 * The canonical copy lives at the repo root because that is also what
 * `npx skills` installs from GitHub. This package copy is a generated artifact
 * (gitignored) and is regenerated on every `prepack` / publish.
 */
import { existsSync, rmSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';

const PKG_DIR = resolve(import.meta.dir, '..');
const SRC = resolve(PKG_DIR, '../../skills');
const DEST = resolve(PKG_DIR, 'skills');

if (!existsSync(SRC)) {
  throw new Error(`[sync-skill] canonical skills dir not found at ${SRC}`);
}

rmSync(DEST, { recursive: true, force: true });
cpSync(SRC, DEST, { recursive: true });

console.log(`[sync-skill] copied ${SRC} -> ${DEST}`);
