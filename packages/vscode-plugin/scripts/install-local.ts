// Local dev installer for the @env-spec VSCode extension.
//
// VS Code / Cursor / Windsurf don't just scan the extensions folder — they
// reconcile it against two bookkeeping files:
//   - extensions.json : the registry of recognized user extensions
//   - .obsolete       : folders to ignore / pending removal
//
// A hand-symlinked folder that isn't in extensions.json (or is stuck in
// .obsolete) silently won't load. This script keeps a live-symlinked install
// (so grammar/dist edits reflect on reload, no repackaging) while writing
// correct, consistent bookkeeping in every editor.
//
// It is idempotent: safe to re-run any time.
//
// Run with: bun run install:local

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG_DIR = path.resolve(__dirname, '..');
const src = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));

// Canonical extension identity. The package name (`env-spec-language`) is
// already a legal extension name, so no rewriting is needed.
const NAME = src.name;
const PUBLISHER = src.publisher;
const VERSION = src.version;
const ID = `${PUBLISHER}.${NAME}`;
const FOLDER = `${ID}-${VERSION}`;
const ID_PREFIX = ID.toLowerCase();

// Items symlinked into the install folder (everything the manifest references:
// `main` → dist, language config + grammar → language, icons → images).
const LINKS = ['dist', 'language', 'images', 'node_modules'];

// Warn early if the extension hasn't been built — it would fail to activate.
if (!fs.existsSync(path.join(PKG_DIR, 'dist', 'extension.js'))) {
  console.warn('⚠  dist/extension.js missing — run `bun run build` first (continuing anyway).');
}

const EDITOR_DIRS = ['.vscode', '.cursor', '.windsurf']
  .map((d) => path.join(os.homedir(), d, 'extensions'))
  .filter((d) => fs.existsSync(d));

if (!EDITOR_DIRS.length) {
  console.log('No editor extensions directories found (.vscode/.cursor/.windsurf).');
  process.exit(0);
}

const readJson = (f: string, fallback: unknown) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};

for (const extDir of EDITOR_DIRS) {
  // Remove any prior install folders for this extension (stale versions, the
  // old whole-package symlink, etc.) so only one consistent copy remains.
  for (const entry of fs.readdirSync(extDir)) {
    if (entry.toLowerCase().startsWith(ID_PREFIX)) {
      fs.rmSync(path.join(extDir, entry), { recursive: true, force: true });
    }
  }

  const folderPath = path.join(extDir, FOLDER);

  // 1. (Re)create the install folder with fresh symlinks + a copied manifest.
  fs.mkdirSync(folderPath, { recursive: true });
  for (const item of LINKS) {
    const target = path.join(PKG_DIR, item);
    if (fs.existsSync(target)) fs.symlinkSync(target, path.join(folderPath, item));
  }
  fs.writeFileSync(
    path.join(folderPath, 'package.json'),
    JSON.stringify(src, null, 2),
  );

  // 2. Clear any stale markers from .obsolete.
  const obsoletePath = path.join(extDir, '.obsolete');
  if (fs.existsSync(obsoletePath)) {
    const obsolete = readJson(obsoletePath, {}) as Record<string, unknown>;
    let changed = false;
    for (const key of Object.keys(obsolete)) {
      if (key.toLowerCase().startsWith(ID_PREFIX)) {
        delete obsolete[key];
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(obsoletePath, JSON.stringify(obsolete));
  }

  // 3. Register a single, correct entry in extensions.json (drop stale ones).
  const regPath = path.join(extDir, 'extensions.json');
  const reg = readJson(regPath, []);
  const cleaned = Array.isArray(reg)
    ? reg.filter((e: any) => !String(e?.identifier?.id ?? '').toLowerCase().startsWith(ID_PREFIX))
    : [];
  cleaned.push({
    identifier: { id: ID },
    version: VERSION,
    location: { $mid: 1, path: folderPath, scheme: 'file' },
    relativeLocation: FOLDER,
  });
  fs.writeFileSync(regPath, JSON.stringify(cleaned));

  console.log(`✓ installed ${ID}@${VERSION} → ${extDir}`);
}

console.log('\nDone. Fully quit and reopen the editor (Cmd+Q, not just reload) to pick up the change.');
