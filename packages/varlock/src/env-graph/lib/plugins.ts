import path from 'node:path';
import { exec as execCb } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import https from 'node:https';
import vm from 'node:vm';
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
import type { EnvGraph } from './env-graph';

// module caching means the file will not be executed multiple times
// so we track just to ensure we don't attempt to do load it multiple times
const importedPluginModulePaths = new Set<string>();

/** Check if we are running inside a compiled binary (SEA = Single Executable Application) */
function isSEABuild(): boolean {
  try {
    return __VARLOCK_SEA_BUILD__;
  } catch {
    return false;
  }
}


/**
 * Loads and executes a plugin module in SEA (single executable application) builds.
 *
 * In compiled binaries, `await import(filePath)` fails with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING
 * because the ESM loader is not wired up for external files. Instead we:
 *   1. Read the plugin file from disk
 *   2. Rewrite ESM `import` declarations to CJS `require()` calls
 *   3. Provide a synthetic `import.meta` object
 *   4. Execute via `node:vm` with access to the current global scope
 *
 * This works because plugin bundles only import Node builtins (tsup inlines everything else)
 * and interact with varlock through the `plugin` global.
 */
async function loadPluginModuleInSEA(filePath: string): Promise<void> {
  const code = fsSync.readFileSync(filePath, 'utf-8');

  // Build a file:// URL for the plugin so import.meta.url resolves correctly.
  // This is critical for plugins that derive __dirname from import.meta.url
  // (e.g. to locate co-located .wasm files).
  const fileUrl = pathToFileURL(filePath).href;
  const pluginDir = path.dirname(filePath);

  // Create a require function scoped to the plugin's directory so
  // bare-specifier requires (e.g. 'fs', 'path') resolve correctly.
  const pluginRequire = createRequire(filePath);

  // Rewrite top-level ESM import declarations → CJS require() calls.
  // We handle the patterns that tsup/esbuild actually emit:
  //   import X from 'mod'            → const X = require('mod')
  //   import { a, b } from 'mod'     → const { a, b } = require('mod')
  //   import X, { a, b } from 'mod'  → const X = require('mod'); const { a, b } = X;
  //   import * as X from 'mod'       → const X = require('mod')
  //   import 'mod'                    → require('mod')
  let transformed = code
    // import DefaultExport, { named1, named2 } from 'module'  (must come first - most specific)
    .replace(
      /^import\s+(\w+)\s*,\s*(\{[^}]+\})\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
      'const $1 = __plugin_require__("$3"); const $2 = $1;',
    )
    // import * as X from 'module'
    .replace(
      /^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
      'const $1 = __plugin_require__("$2");',
    )
    // import { a, b as c } from 'module'
    .replace(
      /^import\s+(\{[^}]+\})\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
      'const $1 = __plugin_require__("$2");',
    )
    // import DefaultExport from 'module'
    .replace(
      /^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
      'const $1 = __plugin_require__("$2");',
    )
    // side-effect-only: import 'module'
    .replace(
      /^import\s+['"]([^'"]+)['"]\s*;?/gm,
      '__plugin_require__("$1");',
    );

  // Replace import.meta references with our synthetic object
  transformed = transformed.replace(/import\.meta/g, '__plugin_import_meta__');

  // Wrap in async IIFE to support top-level await in plugin code
  const wrapped = `(async () => {\n${transformed}\n})()`;

  const context = vm.createContext(globalThis, {
    codeGeneration: { strings: true, wasm: true },
  });

  // Inject helpers into the vm context
  context.__plugin_require__ = pluginRequire;
  context.__plugin_import_meta__ = Object.freeze({
    url: fileUrl,
    dirname: pluginDir,
    filename: filePath,
  });

  const script = new vm.Script(wrapped, { filename: filePath });
  const result = script.runInContext(context);

  // Await the async IIFE in case the plugin uses top-level await
  await result;
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

      // In SEA (compiled binary) builds, dynamic import() of external files fails with
      // ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING. We use a custom loader that rewrites
      // ESM to CJS and evaluates via node:vm instead.
      if (isSEABuild()) {
        await loadPluginModuleInSEA(this.pluginFilePath);
      } else {
        await import(pathToFileURL(this.pluginFilePath).href);
      }
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

          let currentDir = dataSourceDir;
          let nodeModulesPath: string | undefined;
          while (currentDir) {
            if (await pathExists(path.join(currentDir, 'package.json'))) {
              nodeModulesPath = path.join(currentDir, 'node_modules');
              break;
            }
            const parentDir = path.dirname(currentDir);
            if (parentDir === currentDir) break; // will stop when we reach the root
            currentDir = parentDir;
          }

          if (nodeModulesPath) {
            const pluginPackagePath = path.join(nodeModulesPath, moduleName);
            // use locally installed version if it exsists
            if (await pathExists(pluginPackagePath)) {
              // TODO: cache the package.json since we will read it again later
              const pluginPackageJsonPath = path.join(pluginPackagePath, 'package.json');
              const packageJsonString = await fs.readFile(pluginPackageJsonPath, 'utf-8');
              const packageJson = JSON.parse(packageJsonString);
              const packageVersion = packageJson.version;
              if (versionDescriptor && !semver.satisfies(packageVersion, versionDescriptor)) {
                throw new SchemaError(`Installed plugin "${moduleName}" version "${packageVersion}" does not satisfy requested version "${versionDescriptor}"`, {
                  location: getErrorLocation(dataSource, pluginDecorator),
                });
              }
              pluginSrcPath = pluginPackagePath;
            }
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

