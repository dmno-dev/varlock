/**
 * Fetches the iconify icons used by varlock's built-in data types and by each first-party plugin,
 * and writes them into generated modules so type generation can embed them without a network
 * request. varlock core bundles its own icons; each plugin bundles its own and hands them to
 * varlock via `plugin.bundledIcons`. Custom `@icon` values in user schemas are still fetched at
 * generation time.
 *
 * Each icon is also written as a plain `.svg` file in a `bundled-icons/` folder next to the
 * generated module, so the bundled icons can be viewed (and show up in diffs).
 *
 * Each package also gets a `BUNDLED_ICONS_LICENSES.md` with the license notices for the icon sets
 * it ships.
 *
 * Usage:
 *   bun run scripts/sync-bundled-icons.ts          # regenerate files
 *   bun run scripts/sync-bundled-icons.ts --check  # exit 1 if any file is out of date
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTICES_FILENAME = 'BUNDLED_ICONS_LICENSES.md';

// must match ICON_SIZE in packages/varlock/src/env-graph/lib/type-generation/emitters/ts.ts
const ICON_SIZE = 20;

// iconify's collection metadata has no license url for some sets
const LICENSE_URL_OVERRIDES: Record<string, string> = {
  carbon: 'https://github.com/carbon-design-system/carbon/blob/main/LICENSE',
};

const isCheck = process.argv.includes('--check');

type IconTarget = {
  /** package dir, where the notices file is written */
  pkgDir: string;
  /** files scanned for icon names */
  sourceFiles: Array<string>;
  /** generated module path */
  outputPath: string;
  /** plugins must hand the generated icons to varlock via `plugin.bundledIcons` */
  isPlugin: boolean;
};

function listTsFiles(dir: string): Array<string> {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf-8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.gen.ts'))
    .map((entry) => path.join(dir, entry));
}

function getTargets(): Array<IconTarget> {
  const varlockDir = path.join(REPO_ROOT, 'packages/varlock');
  const targets: Array<IconTarget> = [
    {
      pkgDir: varlockDir,
      sourceFiles: [path.join(varlockDir, 'src/env-graph/lib/data-types.ts')],
      outputPath: path.join(varlockDir, 'src/env-graph/lib/type-generation/bundled-icons.gen.ts'),
      isPlugin: false,
    },
  ];
  const pluginsDir = path.join(REPO_ROOT, 'packages/plugins');
  for (const pluginName of fs.readdirSync(pluginsDir).sort()) {
    const srcDir = path.join(pluginsDir, pluginName, 'src');
    if (!fs.existsSync(srcDir)) continue;
    targets.push({
      pkgDir: path.join(pluginsDir, pluginName),
      sourceFiles: listTsFiles(srcDir),
      outputPath: path.join(srcDir, 'bundled-icons.gen.ts'),
      isPlugin: true,
    });
  }
  return targets;
}

// iconify names in icon contexts, like `icon: 'mdi:web'` or `const X_ICON = 'mdi:web'`
const ICON_NAME_PATTERNS = [
  /\bicon\s*[:=]\s*['"]([a-z0-9-]+:[a-z0-9-]+)['"]/g,
  /\b[A-Z0-9_]*ICON\s*=\s*['"]([a-z0-9-]+:[a-z0-9-]+)['"]/g,
];

function collectIconNames(files: Array<string>): Array<string> {
  const names = new Set<string>();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf-8');
    for (const pattern of ICON_NAME_PATTERNS) {
      for (const match of src.matchAll(pattern)) names.add(match[1]);
    }
  }
  return [...names].sort();
}

// returns undefined only for a 404 - any other failure (rate limit, outage) throws, so a flaky
// network can never silently drop icons from the generated files
async function fetchText(url: string): Promise<string | undefined> {
  let res = await fetch(url);
  // iconify rate limits after a few dozen requests, so back off and retry
  for (let attempt = 1; res.status === 429 && attempt <= 5; attempt++) {
    const retryAfterSec = Number(res.headers.get('retry-after')) || 15 * attempt;
    console.log(`[sync-bundled-icons] rate limited, retrying in ${retryAfterSec}s`);
    await sleep(retryAfterSec * 1000);
    res = await fetch(url);
  }
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`[sync-bundled-icons] request failed (${res.status}): ${url}`);
  return res.text();
}

// memoized so icons and licenses shared across packages are only fetched once
const fetchCache = new Map<string, Promise<string | undefined>>();
function fetchTextCached(url: string) {
  if (!fetchCache.has(url)) fetchCache.set(url, fetchText(url));
  return fetchCache.get(url)!;
}

function githubBlobToRaw(url: string) {
  return url
    .replace('https://github.com/', 'https://raw.githubusercontent.com/')
    .replace('/blob/', '/');
}

type CollectionInfo = {
  name: string;
  author?: { name: string; url?: string };
  license?: { title: string; spdx?: string; url?: string };
};

const targets = getTargets();
const targetIconNames = new Map(targets.map((t) => [t, collectIconNames(t.sourceFiles)]));

const allPrefixes = [...new Set([...targetIconNames.values()].flat().map((name) => name.split(':')[0]))].sort();
const collectionsJson = await fetchText(`https://api.iconify.design/collections?prefixes=${allPrefixes.join(',')}`);
const collections = JSON.parse(collectionsJson ?? '{}') as Record<string, CollectionInfo>;

const missing = new Set<string>();
const unwiredPlugins: Array<string> = [];
const expectedFiles: Array<[filePath: string, content: string | undefined]> = [];

for (const target of targets) {
  const icons: Record<string, string> = {};
  for (const name of targetIconNames.get(target)!) {
    const svg = await fetchTextCached(`https://api.iconify.design/${name.replace(':', '/')}.svg?height=${ICON_SIZE}`);
    if (svg) icons[name] = svg;
    else missing.add(name);
  }

  // viewable copies of each icon - `:` is not allowed in windows filenames, so `mdi:web` -> `mdi--web.svg`
  const svgDir = path.join(path.dirname(target.outputPath), 'bundled-icons');
  const svgPaths = new Set<string>();
  for (const [name, svg] of Object.entries(icons)) {
    const svgPath = path.join(svgDir, `${name.replace(':', '--')}.svg`);
    svgPaths.add(svgPath);
    expectedFiles.push([svgPath, svg]);
  }
  if (fs.existsSync(svgDir)) {
    for (const entry of fs.readdirSync(svgDir)) {
      const existingPath = path.join(svgDir, entry);
      if (!svgPaths.has(existingPath)) expectedFiles.push([existingPath, undefined]);
    }
  }

  const notesPath = path.join(target.pkgDir, NOTICES_FILENAME);
  // nothing to bundle - make sure no stale generated files are left behind
  if (!Object.keys(icons).length) {
    expectedFiles.push([target.outputPath, undefined], [notesPath, undefined]);
    continue;
  }

  // a generated icons module does nothing unless the plugin passes it to varlock
  if (target.isPlugin && !target.sourceFiles.some((f) => fs.readFileSync(f, 'utf-8').includes('plugin.bundledIcons'))) {
    unwiredPlugins.push(path.relative(REPO_ROOT, target.pkgDir));
  }

  const prefixes = [...new Set(Object.keys(icons).map((name) => name.split(':')[0]))].sort();
  const noticeSections: Array<string> = [];
  for (const prefix of prefixes) {
    const info = collections[prefix];
    if (!info?.license) throw new Error(`no license info for icon set "${prefix}"`);
    const licenseUrl = LICENSE_URL_OVERRIDES[prefix] ?? info.license.url;
    if (!licenseUrl) throw new Error(`no license url for icon set "${prefix}", add one to LICENSE_URL_OVERRIDES`);
    const licenseText = await fetchTextCached(githubBlobToRaw(licenseUrl));
    if (!licenseText) throw new Error(`license text for "${prefix}" not found at ${licenseUrl}`);
    const usedIcons = Object.keys(icons).filter((name) => name.startsWith(`${prefix}:`));
    noticeSections.push([
      `## ${info.name} (\`${prefix}\`)`,
      '',
      `- Author: ${info.author?.name ?? 'unknown'}${info.author?.url ? ` (${info.author.url})` : ''}`,
      `- License: ${info.license.title}${info.license.spdx ? ` (${info.license.spdx})` : ''}, ${licenseUrl}`,
      `- Icons used: ${usedIcons.map((name) => `\`${name}\``).join(', ')}`,
      '',
      '```',
      licenseText.trim(),
      '```',
    ].join('\n'));
  }

  expectedFiles.push([
    target.outputPath, [
      '// Generated by scripts/sync-bundled-icons.ts (repo root) - do not edit by hand.',
      '// Icons embedded in generated types without a network request. Viewable copies are in',
      `// ./bundled-icons/, license notices in ${NOTICES_FILENAME}`,
      '/* eslint-disable */',
      `export const BUNDLED_ICONS: Record<string, string> = ${JSON.stringify(icons, null, 2)};`,
      '',
    ].join('\n'),
  ]);

  expectedFiles.push([
    notesPath, [
      '# Bundled icon licenses',
      '',
      'This package bundles the following icons (fetched from [Iconify](https://iconify.design)) so',
      'generated types can include them without network access. Generated by',
      '`scripts/sync-bundled-icons.ts` in the varlock repo.',
      '',
      noticeSections.join('\n\n'),
      '',
    ].join('\n'),
  ]);
}

if (missing.size) {
  console.warn(`[sync-bundled-icons] not found on iconify, skipped: ${[...missing].join(', ')}`);
}

if (unwiredPlugins.length) {
  console.error(`[sync-bundled-icons] these plugins use icons but never set \`plugin.bundledIcons\`:\n${unwiredPlugins.map((p) => `  ${p}`).join('\n')}`);
  console.error("add `import { BUNDLED_ICONS } from './bundled-icons.gen';` and `plugin.bundledIcons = BUNDLED_ICONS;` to each");
  process.exitCode = 1;
}

const readOrUndefined = (filePath: string) => (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : undefined);
const stale = expectedFiles.filter(([filePath, content]) => readOrUndefined(filePath) !== content);

if (isCheck) {
  if (stale.length) {
    console.error(`[sync-bundled-icons] out of date:\n${stale.map(([p]) => `  ${path.relative(REPO_ROOT, p)}`).join('\n')}`);
    console.error('run `bun run sync-icons` to update');
    process.exit(1);
  }
  console.log('[sync-bundled-icons] up to date');
} else {
  for (const [filePath, content] of stale) {
    if (content === undefined) {
      fs.rmSync(filePath);
      const dir = path.dirname(filePath);
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } else {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    console.log(`[sync-bundled-icons] ${content === undefined ? 'removed' : 'wrote'} ${path.relative(REPO_ROOT, filePath)}`);
  }
  if (!stale.length) console.log('[sync-bundled-icons] already up to date');
}
