import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import semver from 'semver';
import {
  parseEnvSpecDotEnvFile,
  ParsedEnvSpecFile,
  ParsedEnvSpecDecorator,
  ParsedEnvSpecFunctionArgs,
  ParsedEnvSpecStaticValue,
  ParsedEnvSpecKeyValuePair,
} from '@env-spec/parser';
import { tryCatch } from '@env-spec/utils/try-catch';
import { pathExists } from '@env-spec/utils/fs-utils';

/**
 * `varlock flatten` support - copies every env file reachable via @import into a
 * self-contained output directory and rewrites the @import paths, so a single
 * package can be deployed (e.g. into a Docker image) without the rest of the
 * monorepo being present at runtime.
 *
 * Layout of the output dir:
 * - files inside the package keep their package-relative position at the output root
 * - files outside the package (but inside the workspace) mirror their
 *   workspace-relative position under `.env-imports/`
 *
 * Because both mappings preserve directory structure, relative imports between
 * two copied files stay valid, and rewrites are simple relative-path math.
 *
 * Values are never resolved and plugins are never executed - this is a purely
 * structural transform. Files that need no rewrites are copied byte-for-byte.
 */

const IMPORTS_DIR_NAME = '.env-imports';

export class FlattenError extends Error {}

export type FlattenResult = {
  outDir: string;
  /** files written to the output dir (absolute src -> absolute dest) */
  copiedFiles: Array<{ src: string, dest: string }>;
  /** local (gitignored-style) env files that were skipped */
  skippedLocalFiles: Array<string>;
  /** npm plugins that had their version pinned in rewritten files */
  pinnedPlugins: Array<{ moduleName: string, version: string, filePath: string }>;
  warnings: Array<string>;
};

export type FlattenOptions = {
  /** the package directory whose env files are being flattened (defaults to cwd) */
  packageDir: string;
  /** workspace/monorepo root - imports outside of it cannot be flattened */
  workspaceRootPath: string;
  /** output directory, relative to packageDir unless absolute (default `.env-flat`) */
  outDir?: string;
  /** include .env.local / .env.*.local files (default false - they usually hold machine-local secrets) */
  includeLocal?: boolean;
};

function isEnvFileName(name: string) {
  return name === '.env' || name.startsWith('.env.');
}
function isLocalEnvFileName(name: string) {
  return name === '.env.local' || (name.startsWith('.env.') && name.endsWith('.local'));
}

/** relative path in posix form (import paths always use forward slashes) */
function relativeImportPath(fromDir: string, toPath: string) {
  const rel = path.relative(fromDir, toPath).split(path.sep).join('/');
  return (rel.startsWith('./') || rel.startsWith('../')) ? rel : `./${rel}`;
}

function getFnArgs(dec: ParsedEnvSpecDecorator) {
  if (dec.isBareFnCall && dec.data.value instanceof ParsedEnvSpecFunctionArgs) {
    return dec.data.value;
  }
}

function getStaticKwarg(args: ParsedEnvSpecFunctionArgs, key: string) {
  for (const val of args.values) {
    if (val instanceof ParsedEnvSpecKeyValuePair && val.key === key) {
      if (val.value instanceof ParsedEnvSpecStaticValue) return val.value.value;
      return undefined; // dynamic (fn call) - value unknown at flatten time
    }
  }
  return undefined;
}

function makeStaticPathValue(newPath: string, quote?: '"' | "'" | '`') {
  if (quote) {
    return new ParsedEnvSpecStaticValue({ rawValue: `${quote}${newPath}${quote}`, quote });
  }
  return new ParsedEnvSpecStaticValue({ rawValue: newPath });
}

/** walk up from `fromDir` (stopping at workspaceRoot) looking for node_modules/<moduleName> */
async function findInstalledPluginVersion(
  moduleName: string,
  fromDir: string,
  workspaceRootPath: string,
): Promise<string | undefined> {
  let currentDir = fromDir;
  while (currentDir) {
    const candidatePath = path.join(currentDir, 'node_modules', moduleName, 'package.json');
    if (await pathExists(candidatePath)) {
      const packageJson = await tryCatch(
        async () => JSON.parse(await fs.readFile(candidatePath, 'utf8')),
        () => undefined,
      );
      if (packageJson?.version) return packageJson.version as string;
    }
    if (currentDir === workspaceRootPath) break;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  return undefined;
}

export async function flattenEnvFiles(opts: FlattenOptions): Promise<FlattenResult> {
  const packageDir = path.resolve(opts.packageDir);
  const workspaceRootPath = path.resolve(opts.workspaceRootPath);
  const outDir = path.resolve(packageDir, opts.outDir || '.env-flat');
  const includeLocal = !!opts.includeLocal;

  if (outDir === packageDir || packageDir.startsWith(outDir + path.sep)) {
    throw new FlattenError('flatten output directory cannot contain the package directory');
  }

  const result: FlattenResult = {
    outDir,
    copiedFiles: [],
    skippedLocalFiles: [],
    pinnedPlugins: [],
    warnings: [],
  };

  // src abs path -> dest abs path, for everything already handled (also breaks import cycles)
  const processedFiles = new Map<string, string>();
  const processedDirs = new Set<string>();
  // dest -> src, to detect the (unlikely) case of two sources mapping to the same output path
  const claimedDests = new Map<string, string>();

  function relLabel(absPath: string) {
    const rel = path.relative(packageDir, absPath);
    return rel.startsWith('..') ? absPath : rel;
  }

  /** maps a source path to its output location; undefined = not flattenable (outside the workspace) */
  function getDestPath(srcAbs: string): string | undefined {
    const relFromPackage = path.relative(packageDir, srcAbs);
    if (relFromPackage && !relFromPackage.startsWith('..') && !path.isAbsolute(relFromPackage)) {
      return path.join(outDir, relFromPackage);
    }
    const relFromRoot = path.relative(workspaceRootPath, srcAbs);
    if (!relFromRoot.startsWith('..') && !path.isAbsolute(relFromRoot)) {
      return path.join(outDir, IMPORTS_DIR_NAME, relFromRoot);
    }
    return undefined;
  }

  function claimDest(destAbs: string, srcAbs: string) {
    const existingClaim = claimedDests.get(destAbs);
    if (existingClaim && existingClaim !== srcAbs) {
      throw new FlattenError(
        `flatten output collision: both "${existingClaim}" and "${srcAbs}" map to "${destAbs}"`,
      );
    }
    claimedDests.set(destAbs, srcAbs);
  }

  /** copy a local-path plugin source (single file or self-contained package dir) into the output */
  async function copyPluginSource(pluginAbs: string, destAbs: string) {
    if (processedFiles.has(pluginAbs)) return;
    processedFiles.set(pluginAbs, destAbs);
    claimDest(destAbs, pluginAbs);
    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.cp(pluginAbs, destAbs, { recursive: true });
    result.copiedFiles.push({ src: pluginAbs, dest: destAbs });
  }

  async function rewriteImportDecorator(
    dec: ParsedEnvSpecDecorator,
    srcAbs: string,
    destAbs: string,
  ): Promise<boolean> {
    const args = getFnArgs(dec);
    if (!args || !args.values.length) return false;
    const pathArg = args.values[0];
    // dynamic import paths are a load-time error anyway - nothing to rewrite
    if (!(pathArg instanceof ParsedEnvSpecStaticValue)) return false;
    const importPathStr = String(pathArg.value ?? '');
    if (!importPathStr) return false;

    const isDirImport = importPathStr.endsWith('/');

    let targetAbs: string | undefined;
    if (importPathStr.startsWith('./') || importPathStr.startsWith('../')) {
      targetAbs = path.resolve(path.dirname(srcAbs), importPathStr);
    } else if (importPathStr === '~' || importPathStr.startsWith('~/')) {
      targetAbs = path.join(os.homedir(), importPathStr.slice(1));
    } else if (importPathStr.startsWith('/')) {
      targetAbs = path.resolve(importPathStr);
    } else {
      // http(s):// and npm: imports are not supported by the loader yet
      return false;
    }

    const target = targetAbs;
    const destTarget = getDestPath(target);
    if (!destTarget) {
      result.warnings.push(
        `@import(${importPathStr}) in ${relLabel(srcAbs)} points outside the workspace root and was left untouched - it must exist at that same path wherever the flattened output is used`,
      );
      return false;
    }

    const allowMissing = getStaticKwarg(args, 'allowMissing') === true;
    const fsStat = await tryCatch(async () => fs.stat(target), () => undefined);
    if (!fsStat) {
      if (!allowMissing) {
        result.warnings.push(`@import(${importPathStr}) in ${relLabel(srcAbs)} does not exist - decorator was rewritten but nothing was copied`);
      }
    } else if (isDirImport) {
      // eslint-disable-next-line no-use-before-define
      if (fsStat.isDirectory()) await processDirectory(target);
    } else if (fsStat.isFile()) {
      const fileName = path.basename(target);
      if (isLocalEnvFileName(fileName) && !includeLocal) {
        result.skippedLocalFiles.push(target);
        result.warnings.push(
          `@import(${importPathStr}) in ${relLabel(srcAbs)} targets a local env file, which is excluded by default (rerun with --include-local to include it)`,
        );
      } else {
        // eslint-disable-next-line no-use-before-define
        await processEnvFile(target);
      }
    }

    let newImportPath = relativeImportPath(path.dirname(destAbs), destTarget);
    if (isDirImport) newImportPath += '/';
    if (newImportPath === importPathStr) return false;
    args.data.values[0] = makeStaticPathValue(newImportPath, pathArg.data.quote);
    return true;
  }

  async function rewritePluginDecorator(
    dec: ParsedEnvSpecDecorator,
    srcAbs: string,
    destAbs: string,
  ): Promise<boolean> {
    const args = getFnArgs(dec);
    if (!args || !args.values.length) return false;
    const sourceArg = args.values[0];
    if (!(sourceArg instanceof ParsedEnvSpecStaticValue)) return false;
    const sourceDescriptor = String(sourceArg.value ?? '');
    if (!sourceDescriptor) return false;

    // local path plugin - copy the source (plugins are self-contained) and rewrite the path
    if (sourceDescriptor.startsWith('./') || sourceDescriptor.startsWith('../') || sourceDescriptor.startsWith('/')) {
      const pluginAbs = path.resolve(path.dirname(srcAbs), sourceDescriptor);
      const destPlugin = getDestPath(pluginAbs);
      if (!destPlugin) {
        result.warnings.push(
          `@plugin(${sourceDescriptor}) in ${relLabel(srcAbs)} points outside the workspace root and was left untouched`,
        );
        return false;
      }
      if (!(await pathExists(pluginAbs))) {
        result.warnings.push(`@plugin(${sourceDescriptor}) in ${relLabel(srcAbs)} does not exist - left untouched`);
        return false;
      }
      await copyPluginSource(pluginAbs, destPlugin);
      const newPluginPath = relativeImportPath(path.dirname(destAbs), destPlugin);
      if (newPluginPath === sourceDescriptor) return false;
      args.data.values[0] = makeStaticPathValue(newPluginPath, sourceArg.data.quote);
      return true;
    }

    // other protocols are not supported by the plugin loader yet
    if (/^(https?|npm|jsr|git):/.test(sourceDescriptor)) return false;

    // npm plugin declared in a file that lives inside the package - it resolves from the
    // package's own node_modules at runtime, so leave it alone
    const relFromPackage = path.relative(packageDir, srcAbs);
    if (!relFromPackage.startsWith('..') && !path.isAbsolute(relFromPackage)) return false;

    // npm plugin declared in an imported external file - after flattening it can no longer
    // resolve from the original package's node_modules, so pin the version that is installed
    // there now; at runtime varlock can then auto-download it if it is not installed locally
    const atLocation = sourceDescriptor.indexOf('@', 1);
    const moduleName = atLocation === -1 ? sourceDescriptor : sourceDescriptor.slice(0, atLocation);
    const versionDescriptor = atLocation === -1 ? undefined : sourceDescriptor.slice(atLocation + 1);
    if (versionDescriptor && semver.valid(versionDescriptor)) return false; // already pinned

    const installedVersion = await findInstalledPluginVersion(moduleName, path.dirname(srcAbs), workspaceRootPath);
    if (!installedVersion) {
      result.warnings.push(
        `@plugin(${sourceDescriptor}) in ${relLabel(srcAbs)} could not be resolved to pin a version - install the plugin in this package or pin an exact version manually`,
      );
      return false;
    }
    if (versionDescriptor && !semver.satisfies(installedVersion, versionDescriptor)) {
      result.warnings.push(
        `@plugin(${sourceDescriptor}) in ${relLabel(srcAbs)} - installed version ${installedVersion} does not satisfy the declared range, left untouched`,
      );
      return false;
    }
    args.data.values[0] = makeStaticPathValue(`${moduleName}@${installedVersion}`, sourceArg.data.quote);
    result.pinnedPlugins.push({ moduleName, version: installedVersion, filePath: srcAbs });
    return true;
  }

  async function processEnvFile(srcAbs: string): Promise<void> {
    if (processedFiles.has(srcAbs)) return;
    const destAbs = getDestPath(srcAbs);
    if (!destAbs) return; // callers only pass mappable paths, but guard anyway
    processedFiles.set(srcAbs, destAbs); // set before recursing - breaks import cycles
    claimDest(destAbs, srcAbs);

    const rawContents = await fs.readFile(srcAbs, 'utf8');
    let parsedFile: ParsedEnvSpecFile | undefined;
    try {
      parsedFile = parseEnvSpecDotEnvFile(rawContents);
    } catch {
      parsedFile = undefined;
    }

    let modified = false;
    if (parsedFile) {
      // note: root decorators only - @import/@plugin are only valid in the file header
      for (const dec of parsedFile.decoratorsArray) {
        if (dec.name === 'import') {
          modified = (await rewriteImportDecorator(dec, srcAbs, destAbs)) || modified;
        } else if (dec.name === 'plugin') {
          modified = (await rewritePluginDecorator(dec, srcAbs, destAbs)) || modified;
        }
      }
    } else {
      result.warnings.push(`${relLabel(srcAbs)} could not be parsed - copied as-is without processing imports`);
    }

    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    if (parsedFile && modified) {
      let serialized = parsedFile.toString();
      if (rawContents.endsWith('\n') && !serialized.endsWith('\n')) serialized += '\n';
      await fs.writeFile(destAbs, serialized, 'utf8');
    } else {
      // untouched files are copied byte-for-byte
      await fs.copyFile(srcAbs, destAbs);
    }
    result.copiedFiles.push({ src: srcAbs, dest: destAbs });
  }

  /** copy all env files in an imported directory (directory imports load top-level .env.* files only) */
  async function processDirectory(dirAbs: string): Promise<void> {
    if (processedDirs.has(dirAbs)) return;
    processedDirs.add(dirAbs);
    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !isEnvFileName(entry.name)) continue;
      if (isLocalEnvFileName(entry.name) && !includeLocal) {
        result.skippedLocalFiles.push(path.join(dirAbs, entry.name));
        continue;
      }
      await processEnvFile(path.join(dirAbs, entry.name));
    }
  }

  // start fresh on every run
  if (fsSync.existsSync(outDir)) {
    await fs.rm(outDir, { recursive: true, force: true });
  }

  // process the package's own env files - everything else is reached via imports
  const packageEntries = await fs.readdir(packageDir, { withFileTypes: true });
  let foundAnyEnvFile = false;
  for (const entry of packageEntries) {
    if (!entry.isFile() || !isEnvFileName(entry.name)) continue;
    foundAnyEnvFile = true;
    if (isLocalEnvFileName(entry.name) && !includeLocal) {
      result.skippedLocalFiles.push(path.join(packageDir, entry.name));
      continue;
    }
    await processEnvFile(path.join(packageDir, entry.name));
  }
  if (!foundAnyEnvFile) {
    throw new FlattenError(`no .env files found in ${packageDir}`);
  }

  return result;
}
