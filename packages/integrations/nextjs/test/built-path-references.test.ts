import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(__dirname, '..');
const VARLOCK_DIST = join(PKG_DIR, '../../varlock/dist');

/**
 * These paths are strings in our source, resolved at runtime against built output, so
 * nothing typechecks them. They have silently broken before when output extensions
 * changed (the `.js` -> `.mjs`/`.cjs` move), and the turbopack aliases in particular sit
 * behind a symlink-only branch that the framework tests never execute.
 */
describe('hardcoded references to built files', () => {
  it('turbopack resolveAlias targets exist in varlock/dist', () => {
    const src = readFileSync(join(PKG_DIR, 'src/plugin.ts'), 'utf-8');
    const targets = [...src.matchAll(/'\.\/node_modules\/\.varlock\/dist\/([^']+)'/g)].map((m) => m[1]);

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(existsSync(join(VARLOCK_DIST, target)), `varlock/dist/${target} is aliased but not built`).toBe(true);
    }
  });

  it('require.resolve of sibling build outputs points at files this package emits', () => {
    const sources = ['src/plugin.ts', 'src/webpack-plugin.ts']
      .map((f) => readFileSync(join(PKG_DIR, f), 'utf-8')).join('\n');
    const targets = [...sources.matchAll(/require\.resolve\('\.\/([^']+)'\)/g)].map((m) => m[1]);

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      // node's cjs resolver only probes .js/.json/.node, so an extensionless
      // specifier cannot find the .cjs we emit
      expect(target, `require.resolve('./${target}') needs an explicit extension`).toMatch(/\.[cm]?js$/);
      expect(existsSync(join(PKG_DIR, 'dist', target)), `dist/${target} is resolved but not built`).toBe(true);
    }
  });
});
