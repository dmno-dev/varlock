/**
 * Maintains the icons bundled with varlock (for built-in data types) and with each first-party
 * plugin, so type generation can embed them without a network request. Custom `@icon` values in
 * user schemas are still fetched at generation time.
 *
 * Each package has a `bundled-icons/` folder next to its generated `bundled-icons.gen.ts`. The
 * `.svg` files in that folder are the source of truth: the generated module is built from them.
 *
 * - `<set>--<name>.svg` (e.g. `mdi--web.svg` for `mdi:web`) are fetched from iconify and managed by
 *   this script. Don't edit them; they are overwritten by `--update` and deleted once unused.
 * - `custom--<name>.svg` are hand-maintained and never written or deleted by this script. Use them
 *   as `icon: 'custom:<name>'`. Custom names must be unique across all packages, since every
 *   package's icons share one lookup at runtime. Use `currentColor` for fills/strokes (swapped for
 *   gray in generated types) unless the icon has its own colors. If a custom icon is a modified copy
 *   of an iconify icon, start the file with `<!-- based on <set>:<name> (modified) -->` so the
 *   license notice lists it under that set's license (required for Apache-2.0 sets).
 *
 * Icon set metadata and license text are cached in `scripts/icon-sets/<set>.json`, and each package
 * gets a `BUNDLED_ICONS_LICENSES.md` built from it.
 *
 * Usage:
 *   bun run sync-icons            # fetch missing icons/sets, rebuild generated files
 *   bun run sync-icons --update   # also re-fetch every managed icon and set from iconify
 *   bun run sync-icons --check    # offline: exit 1 if anything is missing or out of date
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_SETS_DIR = path.join(REPO_ROOT, 'scripts/icon-sets');
const NOTICES_FILENAME = 'BUNDLED_ICONS_LICENSES.md';
const ICON_DIR_NAME = 'bundled-icons';
const CUSTOM_PREFIX = 'custom';

// must match ICON_SIZE in packages/varlock/src/env-graph/lib/type-generation/emitters/ts.ts
const ICON_SIZE = 20;

// iconify's collection metadata has no license url for some sets
const LICENSE_URL_OVERRIDES: Record<string, string> = {
  carbon: 'https://github.com/carbon-design-system/carbon/blob/main/LICENSE',
};

const isCheck = process.argv.includes('--check');
const isUpdate = process.argv.includes('--update');
if (isCheck && isUpdate) throw new Error('--check and --update cannot be combined');

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

type IconSetInfo = {
  name: string;
  author?: { name: string; url?: string };
  license: { title: string; spdx?: string; url: string };
  licenseText: string;
};

const problems: Array<string> = [];
const warnings: Array<string> = [];
// [path, expected content] - undefined content means the file should not exist
const expectedFiles: Array<[filePath: string, content: string | undefined]> = [];
const rel = (p: string) => path.relative(REPO_ROOT, p);

// --- discovery ---

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

// `:` is not allowed in windows filenames, so `mdi:web` <-> `mdi--web.svg`
const iconFileName = (iconName: string) => `${iconName.replace(':', '--')}.svg`;
const iconNameFromFile = (fileName: string) => fileName.replace(/\.svg$/, '').replace('--', ':');
const isCustomIcon = (iconName: string) => iconName.startsWith(`${CUSTOM_PREFIX}:`);
const setPrefix = (iconName: string) => iconName.split(':')[0];

// `<!-- based on mdi:web (modified) -->` at the top of a custom icon records where it came from
const BASED_ON_PATTERN = /<!--\s*based on ([a-z0-9-]+:[a-z0-9-]+)/;
// comments are only for maintainers - keep them out of the embedded data uri
const stripComments = (svg: string) => svg.replace(/<!--[\s\S]*?-->/g, '').trim();

// --- network (never used with --check) ---

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

function githubBlobToRaw(url: string) {
  return url
    .replace('https://github.com/', 'https://raw.githubusercontent.com/')
    .replace('/blob/', '/');
}

async function fetchIconSetInfo(prefix: string): Promise<IconSetInfo> {
  const json = await fetchText(`https://api.iconify.design/collections?prefixes=${prefix}`);
  const info = JSON.parse(json ?? '{}')[prefix] as Omit<IconSetInfo, 'licenseText'> | undefined;
  if (!info?.license) throw new Error(`no license info on iconify for icon set "${prefix}"`);
  const licenseUrl = LICENSE_URL_OVERRIDES[prefix] ?? info.license.url;
  if (!licenseUrl) throw new Error(`no license url for icon set "${prefix}", add one to LICENSE_URL_OVERRIDES`);
  const licenseText = await fetchText(githubBlobToRaw(licenseUrl));
  if (!licenseText) throw new Error(`license text for "${prefix}" not found at ${licenseUrl}`);
  return {
    name: info.name,
    author: info.author,
    license: { title: info.license.title, spdx: info.license.spdx, url: licenseUrl },
    licenseText: licenseText.trim(),
  };
}

// --- icon set metadata cache (scripts/icon-sets/<set>.json) ---

const iconSetInfoCache = new Map<string, IconSetInfo>();
async function getIconSetInfo(prefix: string): Promise<IconSetInfo | undefined> {
  if (iconSetInfoCache.has(prefix)) return iconSetInfoCache.get(prefix);
  const cachePath = path.join(ICON_SETS_DIR, `${prefix}.json`);
  let info: IconSetInfo | undefined;
  if (fs.existsSync(cachePath) && !isUpdate) {
    info = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } else if (!isCheck) {
    info = await fetchIconSetInfo(prefix);
  } else {
    problems.push(`missing icon set metadata: ${rel(cachePath)}`);
  }
  if (info) {
    iconSetInfoCache.set(prefix, info);
    expectedFiles.push([cachePath, `${JSON.stringify(info, null, 2)}\n`]);
  }
  return info;
}

// --- per package ---

type BundledIcon = { name: string; svg: string; basedOn?: string };
// custom icons across all packages, to catch name clashes in the shared runtime lookup
const customIconOwners = new Map<string, { svg: string; pkgDir: string }>();

async function processTarget(target: IconTarget) {
  const iconDir = path.join(path.dirname(target.outputPath), ICON_DIR_NAME);
  const existingFiles = fs.existsSync(iconDir) ? fs.readdirSync(iconDir).filter((f) => f.endsWith('.svg')) : [];
  const usedNames = collectIconNames(target.sourceFiles);
  const icons: Array<BundledIcon> = [];

  // custom icons - read as-is, never written or removed
  for (const fileName of existingFiles.filter((f) => f.startsWith(`${CUSTOM_PREFIX}--`))) {
    const name = iconNameFromFile(fileName);
    const svg = fs.readFileSync(path.join(iconDir, fileName), 'utf-8');
    const owner = customIconOwners.get(name);
    if (owner && owner.svg !== svg) {
      problems.push(`"${name}" is defined differently in ${rel(owner.pkgDir)} and ${rel(target.pkgDir)}; custom icon names must be unique`);
    }
    customIconOwners.set(name, { svg, pkgDir: target.pkgDir });
    if (!usedNames.includes(name)) {
      warnings.push(`${rel(path.join(iconDir, fileName))} is not used by ${rel(target.pkgDir)}`);
      continue;
    }
    icons.push({ name, svg, basedOn: svg.match(BASED_ON_PATTERN)?.[1] });
  }

  // managed icons - fetched from iconify when missing (or on --update)
  for (const name of usedNames) {
    if (isCustomIcon(name)) {
      if (!icons.some((icon) => icon.name === name)) {
        problems.push(`${rel(target.pkgDir)} uses "${name}" but ${rel(path.join(iconDir, iconFileName(name)))} does not exist`);
      }
      continue;
    }
    const filePath = path.join(iconDir, iconFileName(name));
    let svg: string | undefined;
    if (fs.existsSync(filePath) && !isUpdate) {
      svg = fs.readFileSync(filePath, 'utf-8');
    } else if (isCheck) {
      problems.push(`missing icon file: ${rel(filePath)}`);
      continue;
    } else {
      svg = await fetchText(`https://api.iconify.design/${name.replace(':', '/')}.svg?height=${ICON_SIZE}`);
      if (!svg) {
        warnings.push(`"${name}" (used by ${rel(target.pkgDir)}) was not found on iconify and is skipped`);
        continue;
      }
    }
    expectedFiles.push([filePath, svg]);
    icons.push({ name, svg });
  }

  // managed icons nothing uses anymore
  for (const fileName of existingFiles) {
    if (fileName.startsWith(`${CUSTOM_PREFIX}--`)) continue;
    if (!usedNames.includes(iconNameFromFile(fileName))) expectedFiles.push([path.join(iconDir, fileName), undefined]);
  }

  const notesPath = path.join(target.pkgDir, NOTICES_FILENAME);
  if (!icons.length) {
    expectedFiles.push([target.outputPath, undefined], [notesPath, undefined]);
    return;
  }

  // a generated icons module does nothing unless the plugin passes it to varlock
  if (target.isPlugin && !target.sourceFiles.some((f) => fs.readFileSync(f, 'utf-8').includes('plugin.bundledIcons'))) {
    problems.push(`${rel(target.pkgDir)} uses icons but never sets \`plugin.bundledIcons\` - add \`import { BUNDLED_ICONS } from './bundled-icons.gen';\` and \`plugin.bundledIcons = BUNDLED_ICONS;\``);
  }

  icons.sort((a, b) => a.name.localeCompare(b.name));
  const iconMap = Object.fromEntries(icons.map((icon) => [icon.name, stripComments(icon.svg)]));
  expectedFiles.push([
    target.outputPath, [
      '// Generated by scripts/sync-bundled-icons.ts (repo root) from ./bundled-icons/ - do not edit by hand.',
      `// Icons embedded in generated types without a network request. License notices: ${NOTICES_FILENAME}`,
      '/* eslint-disable */',
      `export const BUNDLED_ICONS: Record<string, string> = ${JSON.stringify(iconMap, null, 2)};`,
      '',
    ].join('\n'),
  ]);

  // license notices, grouped by the iconify set each icon comes from
  const iconsBySet = new Map<string, Array<string>>();
  const originalIcons: Array<string> = [];
  for (const icon of icons) {
    const source = isCustomIcon(icon.name) ? icon.basedOn : icon.name;
    if (!source) {
      originalIcons.push(icon.name);
      continue;
    }
    const label = isCustomIcon(icon.name) ? `\`${icon.name}\` (modified from \`${source}\`)` : `\`${icon.name}\``;
    iconsBySet.set(setPrefix(source), [...iconsBySet.get(setPrefix(source)) ?? [], label]);
  }

  const sections: Array<string> = [];
  for (const prefix of [...iconsBySet.keys()].sort()) {
    const info = await getIconSetInfo(prefix);
    if (!info) continue;
    sections.push([
      `## ${info.name} (\`${prefix}\`)`,
      '',
      `- Author: ${info.author?.name ?? 'unknown'}${info.author?.url ? ` (${info.author.url})` : ''}`,
      `- License: ${info.license.title}${info.license.spdx ? ` (${info.license.spdx})` : ''}, ${info.license.url}`,
      `- Icons used: ${iconsBySet.get(prefix)!.join(', ')}`,
      '',
      '```',
      info.licenseText,
      '```',
    ].join('\n'));
  }
  if (originalIcons.length) {
    sections.push([
      '## Original icons',
      '',
      `Made for varlock and covered by this package's license: ${originalIcons.map((n) => `\`${n}\``).join(', ')}`,
    ].join('\n'));
  }

  expectedFiles.push([
    notesPath, [
      '# Bundled icon licenses',
      '',
      'This package bundles the following icons so generated types can include them without network',
      'access. Iconify icons are fetched from [Iconify](https://iconify.design). Generated by',
      '`scripts/sync-bundled-icons.ts` in the varlock repo.',
      '',
      sections.join('\n\n'),
      '',
    ].join('\n'),
  ]);
}

// --- run ---

for (const target of getTargets()) await processTarget(target);

// cached set metadata nothing uses anymore
if (fs.existsSync(ICON_SETS_DIR)) {
  for (const fileName of fs.readdirSync(ICON_SETS_DIR)) {
    if (!iconSetInfoCache.has(fileName.replace(/\.json$/, ''))) expectedFiles.push([path.join(ICON_SETS_DIR, fileName), undefined]);
  }
}

for (const warning of warnings) console.warn(`[sync-bundled-icons] warning: ${warning}`);

const readOrUndefined = (filePath: string) => (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : undefined);
const stale = expectedFiles.filter(([filePath, content]) => readOrUndefined(filePath) !== content);

if (isCheck) {
  problems.push(...stale.map(([p, content]) => `${content === undefined ? 'should be removed' : 'out of date'}: ${rel(p)}`));
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
    console.log(`[sync-bundled-icons] ${content === undefined ? 'removed' : 'wrote'} ${rel(filePath)}`);
  }
}

if (problems.length) {
  console.error(`[sync-bundled-icons] problems:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  if (isCheck) console.error('run `bun run sync-icons` to fix missing/out-of-date files');
  process.exit(1);
}
console.log(`[sync-bundled-icons] ${isCheck ? 'up to date' : 'done'}`);
