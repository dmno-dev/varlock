import path from 'node:path';
import { exec as execCb } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import https from 'node:https';
import _ from '@env-spec/utils/my-dash';
import { pathExists } from '@env-spec/utils/fs-utils';


import { FileBasedDataSource, type EnvGraphDataSource } from './data-source';
import {
  CoercionError, ResolutionError, SchemaError, ValidationError,
} from './errors';
import { getErrorLocation } from './error-location';
import { createResolver, type ResolverDef } from './resolver';
import type { ItemDecoratorDef, RootDecoratorDef } from './decorators';
import { createEnvGraphDataType } from './data-types';

import Debug, { type Debugger } from 'debug';

export class VarlockPlugin {
  // readonly localFolderPath?: string;
  // readonly pluginFilePath: string;
  // readonly cliFilePath?: string;

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

  constructor(opts?: {
    localPath?: string,
    loadingError?: Error,
    packageJson?: { name: string; version?: string; description?: string };
  }) {
    this._packageJson = opts?.packageJson;
    this.localPath = opts?.localPath;
    this.loadingError = opts?.loadingError;
    // this.localFolderPath = path.dirname(opts.pluginPath);
    // this.pluginFilePath = opts.pluginPath;
    // this.cliFilePath = opts.cliPath;
  }


  // awkwardly using get here to make sure we bind the debug function to this
  // which lets us destructure it in plugin code
  private debugger: Debugger | undefined;
  get debug() {
    return (...args: Parameters<Debugger>) => {
      if (!this.debugger) {
        if (!this.name) throw new Error('expected plugin name to be set before using debug');
        this.debugger = Debug(`varlock:plugin:${this.name}`);
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
}


async function loadPluginFromLocalPath(localPath: string) {
  let plugin: VarlockPlugin;
  let pluginModulePath: string;

  const stats = await fs.stat(localPath);

  // If it's a file, load the plugin directly
  if (stats.isFile()) {
    pluginModulePath = localPath;
    plugin = new VarlockPlugin({
      localPath,
    });

  // If it's a directory, load package.json and use exports field
  } else if (stats.isDirectory()) {
    const pkgJsonPath = path.join(localPath, 'package.json');
    if (!(await pathExists(pkgJsonPath))) {
      return new VarlockPlugin({
        localPath,
        loadingError: new Error(`Plugin ${localPath} is missing package.json file`),
      });
    }

    const packageJsonContents = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8'));
    plugin = new VarlockPlugin({ packageJson: packageJsonContents });

    // plugin.name = pkgJson.name;
    // plugin.version = pkgJson.version;
    // plugin.description = pkgJson.description;

    // Get plugin path (and in future cli) from exports field
    const exports = packageJsonContents.exports || {};
    if (exports['./plugin']) {
      pluginModulePath = path.join(localPath, exports['./plugin']);
    } else {
      throw new Error(`No ./plugin export or main field found in package.json: ${localPath}`);
    }
  } else {
    throw new Error(`Invalid plugin path (not a file or directory): ${localPath}`);
  }

  // temporarily attach plugin to globalThis so dynamically imported module can access it
  (globalThis as any).plugin = plugin;
  try {
    // slightly nicer error than the default MODULE_NOT_FOUND
    if (!await pathExists(pluginModulePath)) throw new Error(`Plugin file not found: ${pluginModulePath}`);
    await import(pluginModulePath);
  } catch (err) {
    plugin.loadingError = err as Error;
  }
  delete (globalThis as any).plugin;
  return plugin;
}

async function downloadPlugin(url: string) {
  const exec = promisify(execCb);
  const cacheDir = path.join(os.homedir(), '.varlock', 'plugins-cache');
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
  // TODO: use name+version+random hash
  const safePackageName = (pkgJson.name || '').replaceAll('/', '-').replaceAll('@', '');
  const dirName = `${safePackageName}_${(pkgJson.version || '')}_${crypto.randomBytes(4).toString('hex')}`;
  const finalDir = path.join(cacheDir, dirName);

  // Move extracted folder to finalDir
  await fs.rm(finalDir, { recursive: true, force: true });
  await fs.rename(pluginRoot, finalDir);
  await fs.rm(tmpTgz, { force: true });
  await fs.rm(tmpExtractDir, { recursive: true, force: true });

  // Update index.json
  index[url] = dirName;
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

  return finalDir;
}



export async function loadPlugins(dataSource: EnvGraphDataSource) {
  // handle plugin decorators
  const installPluginDecorators = dataSource.getRootDecFns('plugin');
  if (installPluginDecorators.length) {
    dataSource.plugins ||= [];
    for (const pluginDecorator of installPluginDecorators) {
      const installPluginArgs = await pluginDecorator.resolve();
      const pluginSourceDescriptor = installPluginArgs.arr[0];
      if (!_.isString(pluginSourceDescriptor)) {
        throw new SchemaError('Bad @plugin - must provide a string source location');
      }

      let pluginSrcPath: string | undefined;

      // install from relative path
      if (pluginSourceDescriptor.startsWith('./') || pluginSourceDescriptor.startsWith('../') || pluginSourceDescriptor.startsWith('/')) {
        if (!(dataSource instanceof FileBasedDataSource)) {
          dataSource._loadingError = new Error('@plugin with local path can only be used from a file-based data source');
          return;
        }
        pluginSrcPath = pluginSourceDescriptor.startsWith('/') ? pluginSourceDescriptor : path.resolve(path.dirname(dataSource.fullPath), pluginSourceDescriptor);
        if (!(await pathExists(pluginSrcPath))) {
          // in this case, the bad path is the user's fault
          dataSource._loadingError = new SchemaError(`Bad @plugin path: ${pluginSourceDescriptor}`, {
            location: getErrorLocation(dataSource, pluginDecorator),
          });
          return;
        }
      } else if (pluginSourceDescriptor.startsWith('http://')) {
        dataSource._loadingError = new Error('http imports must be over https');
        return;
      } else if (pluginSourceDescriptor.startsWith('https://')) {
        const downloadedLocalPath = await downloadPlugin(pluginSourceDescriptor);
        pluginSrcPath = downloadedLocalPath;
      } else if (pluginSourceDescriptor.startsWith('npm:')) {
        dataSource._loadingError = new Error('npm imports not supported yet');
        return;
      } else {
        dataSource._loadingError = new Error('unsupported plugin import type');
        return;
      }

      if (pluginSrcPath) {
        dataSource.plugins.push(await loadPluginFromLocalPath(pluginSrcPath));
      }
    }
  }
  const graph = dataSource.graph;
  if (!graph) throw new Error('Data source not attached to graph');
  for (const plugin of dataSource.plugins || []) {
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


// export function createVarlockPlugin(
//   basicPluginInfo: {
//     name: string,
//     version?: string,
//     description?: string,
//     icon?: string,
//   },

// ) {
//   const plugin = new VarlockPlugin(basicPluginInfo);
//   defPluginFn(plugin);
// }

export type definePluginFn = (p: VarlockPlugin) => void;

