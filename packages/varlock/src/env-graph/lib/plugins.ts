import path from 'node:path';
import { exec as execCb } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import crypto from 'node:crypto';
import https from 'node:https';
import ansis from 'ansis';
import semver from 'semver';
import _ from '@env-spec/utils/my-dash';
import { pathExists } from '@env-spec/utils/fs-utils';
import { getUserVarlockDir } from '../../lib/user-config-dir';


import { FileBasedDataSource, type EnvGraphDataSource } from './data-source';
import {
  CoercionError, ResolutionError, SchemaError, ValidationError,
} from './errors';
import { getErrorLocation } from './error-location';
import { createResolver, type ResolverDef } from './resolver';
import type {
  DecoratorInstance, ItemDecoratorDef, RootDecoratorDef, RootDecoratorInstance,
} from './decorators';
import { createEnvGraphDataType } from './data-types';

import { createDebug, type Debugger } from '../../lib/debug';
import { getWorkspaceInfo } from '../../lib/workspace-utils';
import type { EnvGraph } from './env-graph';

// module caching means the file will not be executed multiple times
// so we track just to ensure we don't attempt to do load it multiple times
const importedPluginModulePaths = new Set<string>();

// One-time Bun compat patch applied before any plugin loads.
// In Bun, globalThis.crypto IS the Web Crypto API (no .webcrypto sub-property).
// CJS bundles (e.g. bitwarden) use `crypto.webcrypto.subtle`, so we patch it once.
let _cryptoShimApplied = false;
function applyBunCryptoShim() {
  if (_cryptoShimApplied) return;
  _cryptoShimApplied = true;
  const globalCrypto = (globalThis as any).crypto;
  if (globalCrypto && !globalCrypto.webcrypto) {
    try {
      Object.defineProperty(globalCrypto, 'webcrypto', {
        get() { return globalCrypto; },
        configurable: true,
        enumerable: false,
      });
    } catch {
      // ignore if crypto object is not extensible
    }
  }
}

/**
 * Loads and executes a CJS plugin module.
 *
 * Plugins are built as CJS. We use `new Function` to create a CJS module scope
 * (exports, require, module, __filename, __dirname) — this runs in the main
 * Node.js/Bun context so all built-in globals (DOMException, fetch, etc.) work
 * correctly. Top-level var/let/const declarations are scoped to the function and
 * do not leak between plugins.
 *
 * We intentionally avoid vm.createContext with a Proxy sandbox because Node.js
 * C++ lazy property initializers (e.g. for DOMException) assert IsolateData
 * exists on the context, which is not set up for Proxy-based vm contexts.
 */
function loadPluginModule(filePath: string): void {
  applyBunCryptoShim();

  const code = fsSync.readFileSync(filePath, 'utf-8');
  const pluginDir = path.dirname(filePath);
  const moduleObj = { exports: {} as any };
  const requireFn = createRequire(filePath);

  // eslint-disable-next-line no-new-func
  const moduleFn = new Function('exports', 'require', 'module', '__filename', '__dirname', code);
  moduleFn(moduleObj.exports, requireFn, moduleObj, filePath, pluginDir);
}


export class VarlockPlugin {
  // helper so end user code can get same error classes
  readonly ERRORS = {
    ValidationError,
    CoercionError,
    SchemaError,
    ResolutionError,
  };

  private _packageJson?: Record<string, any>;

  private _name?: string;
  get name() { return this._packageJson?.name || this._name || 'unnamed plugin'; }
  set name(val: string) { this._name = val; }

  private _version?: string;
  get version() { return this._packageJson?.version || this._version || '0.0.0'; }
  set version(val: string) { this._version = val; }

  private _icon?: string;
  get icon() { return this._icon || 'mdi:puzzle'; }
  set icon(val: string) { this._icon = val; }

  loadingError?: Error;
  warnings: Array<SchemaError> = [];

  readonly localPath?: string;

  /** reference to the `@plugin()` decorator instance(s) that installed the plugin  */
  installDecoratorInstances: Array<DecoratorInstance> = [];

  type: 'single-file' | 'package';

  constructor(opts: {
    type: 'single-file' | 'package',
    localPath: string,
    loadingError?: Error,
    packageJson?: { name: string; version?: string; description?: string };
  }) {
    this.type = opts.type;
    this.localPath = opts?.localPath;
    this._packageJson = opts?.packageJson;
  }

  // awkwardly using get here to make sure we bind the debug function to this
  // which lets us destructure it in plugin code
  private debugger: Debugger | undefined;
  get debug() {
    return (...args: Parameters<Debugger>) => {
      if (!this.debugger) {
        if (!this.name) throw new Error('expected plugin name to be set before using debug');
        this.debugger = createDebug(`varlock:plugin:${this.name}`);
      }
      return this.debugger(...args);
    };
  }


  readonly dataTypes?: Array<Parameters<typeof createEnvGraphDataType>[0]> = [];
  registerDataType(dataTypeDef: Parameters<typeof createEnvGraphDataType>[0]) {
    this.debug('registerDataType', dataTypeDef.name);
    this.dataTypes!.push(dataTypeDef);
  }

  readonly rootDecorators?: Array<RootDecoratorDef<any>> = [];
  registerRootDecorator<T>(decoratorDef: RootDecoratorDef<T>) {
    this.debug('registerRootDecorator', decoratorDef.name);
    this.rootDecorators!.push(decoratorDef);
  }

  readonly itemDecorators?: Array<ItemDecoratorDef<any>> = [];
  registerItemDecorator<T>(decoratorDef: ItemDecoratorDef<T>) {
    this.debug('registerItemDecorator', decoratorDef.name);
    this.itemDecorators!.push(decoratorDef);
  }

  readonly resolverFunctions?: Array<ResolverDef<any>> = [];
  registerResolverFunction<T>(resolverDef: ResolverDef<T>) {
    this.debug('registerResolverFunction', resolverDef.name);
    this.resolverFunctions!.push(resolverDef);
  }

  /**
   * Declare standard env vars this plugin uses.
   * Set during plugin init — the loading infrastructure will automatically
   * check for these vars and generate warnings if they are detected but not wired up.
   *
   * `key` accepts a single env var name or an array of alternatives — the first match is used.
   * `dataType` is used to generate `# @type=...` schema lines for vars not in the schema.
   */
  standardVars?: {
    initDecorator: string,
    params: Record<string, { key: string | Array<string>, dataType?: string }>,
  };

  /** called by the loading infrastructure — checks declared standardVars against the graph */
  _checkStandardVars(graph: { overrideValues: Record<string, string | undefined>, configSchema: Record<string, any> }) {
    if (!this.standardVars) return;
    const { initDecorator, params } = this.standardVars;

    // resolve each param to the first matching env key
    const resolved = Object.entries(params).map(([paramName, { key, dataType }]) => {
      const keys = Array.isArray(key) ? key : [key];
      const matchedKey = keys.find((k) => graph.overrideValues[k]);
      return {
        paramName, matchedKey, resolvedKey: matchedKey || keys[0], dataType,
      };
    });

    const detected = resolved.filter((v) => v.matchedKey);
    if (detected.length === 0) return;

    const detectedKeys = detected.map((v) => v.matchedKey!);
    const needsSchemaSet = new Set(
      detected.filter((v) => !(v.resolvedKey in graph.configSchema)).map((v) => v.resolvedKey),
    );

    const wiringParams = detected
      .map((v) => ansis.green(`${v.paramName}=$${v.resolvedKey}`))
      .join(', ');

    const tip: Array<string> = [
      '',
      'Include in your schema and use in plugin initialization:',
      '',
      `  # ${initDecorator}(..., ${wiringParams})`,
      '  # ---',
    ];

    for (const v of detected) {
      const inSchema = !needsSchemaSet.has(v.resolvedKey);
      if (v.dataType) {
        const typeLine = `  # @type=${v.dataType}`;
        tip.push(inSchema ? typeLine : ansis.green(typeLine));
      }
      const itemLine = `  ${v.resolvedKey}=`;
      tip.push(inSchema ? itemLine : ansis.green(itemLine));
    }

    tip.push('');

    this.warnings.push(new SchemaError(
      `${detectedKeys.join(', ')} found in environment but not connected to plugin`,
      { isWarning: true, tip },
    ));
  }

  get pluginFilePath() {
    if (this.type === 'single-file') return this.localPath!;
    const pluginExport = this._packageJson?.exports?.['./plugin'] || '';
    if (!pluginExport) throw new Error('Plugin package.json is missing ./plugin export');
    return path.join(this.localPath!, pluginExport);
  }

  async executePluginModule() {
    // temporarily attach plugin to globalThis so dynamically imported module can access it
    (globalThis as any).plugin = this;

    try {
      // slightly nicer error than the default MODULE_NOT_FOUND
      if (!await pathExists(this.pluginFilePath)) throw new Error(`Plugin file not found: ${this.pluginFilePath}`);

      importedPluginModulePaths.add(this.pluginFilePath);

      // note - we don't export anything
      // instead we inject the plugin, and then modify it

      loadPluginModule(this.pluginFilePath);
    } catch (err) {
      this.loadingError = err as Error;
    }
    delete (globalThis as any).plugin;
  }
}



async function initPluginFromLocalPath(localPath: string) {
  const stats = await fs.stat(localPath);

  // If it's a file, load the plugin directly
  if (stats.isFile()) {
    const ext = path.extname(localPath).toLowerCase();
    if (['.js', '.cjs', '.mjs'].includes(ext) === false) {
      throw new SchemaError(`Single-file plugin must be a .js, .cjs, or .mjs file: ${localPath}`);
    }

    return new VarlockPlugin({
      type: 'single-file',
      localPath,
    });

  // If it's a directory, load package.json and use exports field
  } else if (stats.isDirectory()) {
    const pkgJsonPath = path.join(localPath, 'package.json');
    if (!(await pathExists(pkgJsonPath))) {
      throw new SchemaError('Plugin is missing package.json file');
    }

    const packageJsonContents = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8'));
    if (!packageJsonContents.exports?.['./plugin']) {
      throw new SchemaError('Plugin is missing "./plugin" export in package.json');
    }

    return new VarlockPlugin({
      type: 'package',
      localPath,
      packageJson: packageJsonContents,
    });
  } else {
    throw new Error(`Invalid plugin path (not a file or directory): ${localPath}`);
  }
}


async function registerPluginInGraph(graph: EnvGraph, plugin: VarlockPlugin, pluginDecorator: RootDecoratorInstance) {
  let existingPlugin: VarlockPlugin | undefined;
  for (const possibleMatchingPlugin of graph.plugins) {
    if (plugin.type === 'single-file') {
      if (possibleMatchingPlugin.type === 'single-file' && possibleMatchingPlugin.localPath === plugin.localPath) {
        existingPlugin = possibleMatchingPlugin;
      }
    } else if (plugin.type === 'package') {
      if (possibleMatchingPlugin.name === plugin.name) {
        if (possibleMatchingPlugin.version === plugin.version) {
          const installedInSources = possibleMatchingPlugin.installDecoratorInstances.map((dec) => dec.dataSource);
          if (installedInSources.includes(pluginDecorator.dataSource)) {
            pluginDecorator._schemaErrors.push(new SchemaError(`Plugin ${plugin.name} already installed in this data source`));
            return;
          }

          existingPlugin = possibleMatchingPlugin;
        } else {
          pluginDecorator._schemaErrors.push(new SchemaError(`Plugin ${plugin.name} version conflict: tried to install version ${plugin.version} but version ${possibleMatchingPlugin.version} is already installed`));
          return;
        }
      }
    }
  }
  if (existingPlugin) {
    existingPlugin.installDecoratorInstances.push(pluginDecorator);
    return;
  }

  plugin.installDecoratorInstances.push(pluginDecorator);
  graph.plugins.push(plugin);

  // this finally executes the plugin code
  await plugin.executePluginModule();

  // if plugin failed to load, don't try to register its exports
  if (plugin.loadingError) {
    return;
  }

  // register decorators, resolvers, data types from this plugin
  for (const rootDec of plugin.rootDecorators || []) {
    graph.registerRootDecorator(rootDec);
  }
  for (const itemDec of plugin.itemDecorators || []) {
    graph.registerItemDecorator(itemDec);
  }
  for (const dataType of plugin.dataTypes || []) {
    graph.registerDataType(createEnvGraphDataType(dataType));
  }
  for (const resolverDef of plugin.resolverFunctions || []) {
    // might want to move into plugin load process
    graph.registerResolver(createResolver(resolverDef));
  }
}

async function downloadPlugin(url: string) {
  const exec = promisify(execCb);
  const cacheDir = path.join(getUserVarlockDir(), 'plugins-cache');
  const indexPath = path.join(cacheDir, 'index.json');
  await fs.mkdir(cacheDir, { recursive: true });

  // Load or create index.json
  let index: Record<string, string> = {};
  try {
    const indexRaw = await fs.readFile(indexPath, 'utf-8');
    index = JSON.parse(indexRaw);
  } catch {
    // ignore, treat as empty
  }

  if (index[url]) {
    const pluginDir = path.join(cacheDir, index[url]);
    if (await fs.stat(pluginDir).then(() => true, () => false)) {
      return pluginDir;
    }
    // If mapping exists but folder is missing, fall through to re-download
  }

  // Download the file
  const tmpTgz = path.join(cacheDir, `tmp-${crypto.randomBytes(8).toString('hex')}.tgz`);
  await new Promise<void>((resolve, reject) => {
    const file = fsSync.createWriteStream(tmpTgz);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download plugin: ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    }).on('error', reject);
  });

  // Extract tgz to a temp folder
  const tmpExtractDir = path.join(cacheDir, `tmp-extract-${crypto.randomBytes(8).toString('hex')}`);
  await fs.mkdir(tmpExtractDir);
  await exec(`tar -xzf ${tmpTgz} -C ${tmpExtractDir}`);

  // Find package.json (assume in package/ or root)
  let pkgJsonPath = path.join(tmpExtractDir, 'package', 'package.json');
  let pluginRoot = path.join(tmpExtractDir, 'package');
  if (!(await fs.stat(pkgJsonPath).then(() => true, () => false))) {
    pkgJsonPath = path.join(tmpExtractDir, 'package.json');
    pluginRoot = tmpExtractDir;
    if (!(await fs.stat(pkgJsonPath).then(() => true, () => false))) {
      throw new Error('package.json not found in plugin tgz');
    }
  }
  const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8'));

  // Generate unique hash for folder name
  const safePackageName = (pkgJson.name || '').replaceAll('/', '-').replaceAll('@', '');
  const dirName = `${safePackageName}_${(pkgJson.version || '')}_${crypto.randomBytes(4).toString('hex')}`;
  const finalDir = path.join(cacheDir, dirName);

  // Move extracted folder to finalDir
  await fs.rm(finalDir, { recursive: true, force: true });
  await fs.rename(pluginRoot, finalDir);
  await fs.rm(tmpTgz, { force: true });
  await fs.rm(tmpExtractDir, { recursive: true, force: true });

  // Update index.json file with mapping b/w url and new folder
  index[url] = dirName;
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

  return finalDir;
}



export async function processPluginInstallDecorators(dataSource: EnvGraphDataSource) {
  const graph = dataSource.graph;
  if (!graph) throw new Error('Data source not attached to graph');

  // handle plugin decorators
  const installPluginDecorators = dataSource.getRootDecFns('plugin');
  if (installPluginDecorators.length) {
    if (!(dataSource instanceof FileBasedDataSource)) {
      dataSource._loadingError = new Error('@plugin can only be used from a file-based data source');
      return;
    }
    const dataSourceDir = path.dirname(dataSource.fullPath);
    for (const pluginDecorator of installPluginDecorators) {
      let pluginSrcPath: string | undefined;
      try {
        const installPluginArgs = await pluginDecorator.resolve();
        const pluginSourceDescriptor = installPluginArgs.arr[0];
        if (!_.isString(pluginSourceDescriptor)) {
          throw new SchemaError('Bad @plugin - must provide a string source location');
        }
        // install from local file path
        if (pluginSourceDescriptor.startsWith('./') || pluginSourceDescriptor.startsWith('../') || pluginSourceDescriptor.startsWith('/')) {
          pluginSrcPath = pluginSourceDescriptor.startsWith('/') ? pluginSourceDescriptor : path.resolve(dataSourceDir, pluginSourceDescriptor);
          if (!(await pathExists(pluginSrcPath))) {
            // in this case, the bad path is the user's fault
            throw new SchemaError(`Bad @plugin path: ${pluginSourceDescriptor}`);
          }
        } else if (pluginSourceDescriptor.includes(':')) {
          const protocol = pluginSourceDescriptor.split(':')[0];
          // protocols that we will likely support in future
          if (['https', 'npm', 'jsr', 'git'].includes(protocol)) {
            throw new SchemaError(`@plugin source protocol "${protocol}" is not yet supported`);
          } else {
            throw new SchemaError(`Bad @plugin source protocol: ${protocol}`);
          }

        // we will assume its a npm module name - `packageName` / `packageName@version`
        } else {
          const atLocation = pluginSourceDescriptor.indexOf('@', 1);
          let versionDescriptor: string | undefined;
          let moduleName: string | undefined;
          if (atLocation === -1) {
            moduleName = pluginSourceDescriptor;
          } else {
            moduleName = pluginSourceDescriptor.slice(0, atLocation);
            versionDescriptor = pluginSourceDescriptor.slice(atLocation + 1);
          }

          if (!moduleName.startsWith('@varlock/')) {
            throw new SchemaError(`Plugin "${moduleName}" blocked - only official @varlock/* plugins are supported for now, third-party plugins will be supported in future releases`);
          }

          const semverRange = semver.validRange(versionDescriptor);
          if (versionDescriptor && !semverRange) {
            throw new SchemaError(`Bad @plugin version descriptor: ${versionDescriptor}`);
          } else if (semverRange === '*') {
            throw new SchemaError(`Version descriptor "${versionDescriptor}" is too broad`);
          } else if (versionDescriptor === '') {
            throw new SchemaError('Bad @plugin version descriptor - remove "@" or specify a valid version');
          }

          // Walk up the directory tree checking each node_modules for the plugin.
          // This supports monorepos where npm/yarn/pnpm may hoist packages to the
          // root node_modules rather than the workspace's own node_modules.
          const workspaceRootPath = getWorkspaceInfo()?.rootPath;

          let currentDir = dataSourceDir;
          let nodeModulesPath: string | undefined;
          while (currentDir) {
            if (!nodeModulesPath && await pathExists(path.join(currentDir, 'package.json'))) {
              // Track the nearest package.json's node_modules for error messages
              nodeModulesPath = path.join(currentDir, 'node_modules');
            }

            const candidatePluginPath = path.join(currentDir, 'node_modules', moduleName);
            if (await pathExists(candidatePluginPath)) {
              // TODO: cache the package.json since we will read it again later
              const pluginPackageJsonPath = path.join(candidatePluginPath, 'package.json');
              const packageJsonString = await fs.readFile(pluginPackageJsonPath, 'utf-8');
              const packageJson = JSON.parse(packageJsonString);
              const packageVersion = packageJson.version;
              if (versionDescriptor && !semver.satisfies(packageVersion, versionDescriptor)) {
                throw new SchemaError(`Installed plugin "${moduleName}" version "${packageVersion}" does not satisfy requested version "${versionDescriptor}"`, {
                  location: getErrorLocation(dataSource, pluginDecorator),
                });
              }
              pluginSrcPath = candidatePluginPath;
              break;
            }

            // stop at the workspace root - no need to search beyond it
            if (workspaceRootPath && currentDir === workspaceRootPath) break;

            const parentDir = path.dirname(currentDir);
            if (parentDir === currentDir) break; // will stop when we reach the filesystem root
            currentDir = parentDir;
          }

          // attempt to fetch from npm if we did not succeed getting a local path above
          if (!pluginSrcPath) {
            if (!versionDescriptor) {
              // this tells us if the user is using package.json, so we can make the error message more helpful
              if (nodeModulesPath) {
                throw new SchemaError(`Plugin "${moduleName}" unable to resolve - install locally via your package.json file`);
              } else {
                throw new SchemaError(`Plugin "${moduleName}" unable to resolve - set a fixed version (e.g., \`@plugin(${moduleName}@1.2.3)\`)`);
              }
            } else if (!semver.valid(versionDescriptor)) {
              throw new SchemaError(`Plugin "${moduleName}" must use a fixed version when not installing via package.json (e.g., \`@plugin(${moduleName}@1.2.3)\`)`, {
                location: getErrorLocation(dataSource, pluginDecorator),
              });
            }

            // ex: https://registry.npmjs.org/@varlock/plugin-name/1.2.3
            const npmInfoUrl = `https://registry.npmjs.org/${moduleName}/${versionDescriptor}`;
            const npmInfoReq = await fetch(npmInfoUrl);
            if (!npmInfoReq.ok) {
              // TODO: new error type? check for 404 vs others and give better message
              throw new Error(`Failed to fetch plugin "${moduleName}@${versionDescriptor}" from npm: ${npmInfoReq.status} ${npmInfoReq.statusText}`);
            }
            const npmInfo = await npmInfoReq.json() as any;
            const tarballUrl = npmInfo?.dist?.tarball;
            if (!tarballUrl) {
              throw new Error(`Failed to find tarball URL for plugin "${moduleName}@${versionDescriptor}" from npm`);
            }

            // downloads into local cache folder (user varlock config dir / plugins-cache/)
            const downloadedPluginPath = await downloadPlugin(tarballUrl);
            pluginSrcPath = downloadedPluginPath;
          }
        }

        const plugin = await initPluginFromLocalPath(pluginSrcPath);
        // might return an existing plugin if matches one in the graph
        await registerPluginInGraph(graph, plugin, pluginDecorator);
      } catch (err) {
        pluginDecorator._schemaErrors.push(err as any);
        continue;
      }
    }
  }
}

export type VarlockPluginCtx = {
  debug: Debugger,
  errors: {
    ValidationError: typeof ValidationError,
    CoercionError: typeof CoercionError,
    SchemaError: typeof SchemaError,
    ResolutionError: typeof ResolutionError,
  }
};

export type definePluginFn = (p: VarlockPlugin) => void;

