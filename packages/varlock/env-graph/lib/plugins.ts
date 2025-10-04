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
import { type ResolverDef } from './resolver';
import type { ItemDecoratorDef, RootDecoratorDef } from './decorators';
import type { createEnvGraphDataType } from './data-types';

import Debug, { type Debugger } from 'debug';
import { AsyncLocalStorage } from 'node:async_hooks';

export type VarlockPluginDef = {
  /** descriptive name of the plugin */
  name: string;
  /**
   * version number (semver) of the plugin
   * @example "1.2.3"
   * */
  version?: string;
  icon?: string;
  description?: string;
  hooks?: {},
  rootDecorators?: Array<RootDecoratorDef>;
  itemDecorators?: Array<ItemDecoratorDef>;
  resolverFunctions?: Array<ResolverDef>;
  dataTypes?: Array<Parameters<typeof createEnvGraphDataType>[0]>;
};


const pluginCtxAls = new AsyncLocalStorage<VarlockPluginCtx>({ name: 'varlock-plugin-ctx' });

async function loadPluginModuleFromPath(pluginPath: string): Promise<any> {
  const pluginCtx: VarlockPluginCtx = {
    debug: Debug('varlock:plugin'),
    errors: {
      CoercionError, ResolutionError, SchemaError, ValidationError,
    },
  };
  const pluginModule = await pluginCtxAls.run(pluginCtx, async () => {
    return await import(pluginPath);
  });

  console.log(pluginModule);

  if (!('plugin' in pluginModule)) {
    throw new Error('Expected plugin module to export "plugin" function');
  }

  return pluginModule.plugin as VarlockPluginDef;
}

export class VarlockPlugin {
  localFolderPath?: string;
  pluginFilePath: string;
  cliFilePath?: string;
  def: VarlockPluginDef;

  constructor(opts: {
    pluginPath: string,
    def: VarlockPluginDef,
    cliPath?: string,
  }) {
    this.localFolderPath = path.dirname(opts.pluginPath);
    this.pluginFilePath = opts.pluginPath;
    this.cliFilePath = opts.cliPath;
    this.def = opts.def;
  }

  static async init(localPath: string) {
    const stats = await fs.stat(localPath);

    // If it's a file, load the plugin directly
    if (stats.isFile()) {
      const pluginPath = localPath;
      // const def = (await import(pluginPath)).default;
      const def = await loadPluginModuleFromPath(pluginPath);
      return new VarlockPlugin({
        pluginPath,
        def,
      });

    // If it's a directory, load package.json and use exports field
    } else if (stats.isDirectory()) {
      const pkgJsonPath = path.join(localPath, 'package.json');
      if (!(await pathExists(pkgJsonPath))) {
        throw new Error(`package.json not found in plugin directory: ${localPath}`);
      }

      const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8'));

      // Get plugin and cli paths from exports field
      const exports = pkgJson.exports || {};
      let pluginPath: string | undefined;
      let cliPath: string | undefined;

      if (exports['./plugin']) {
        pluginPath = path.join(localPath, exports['./plugin']);
      } else {
        throw new Error(`No ./plugin export or main field found in package.json: ${localPath}`);
      }
      if (exports['./cli']) {
        cliPath = path.join(localPath, exports['./cli']);
      }

      // Load the plugin definition
      const def = await loadPluginModuleFromPath(pluginPath);

      return new VarlockPlugin({
        pluginPath,
        def,
        cliPath,
      });
    } else {
      throw new Error(`Invalid plugin path (not a file or directory): ${localPath}`);
    }
  }
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
  const installPluginDecorators = dataSource.getRootDecorators('plugin');
  if (installPluginDecorators.length) {
    for (const pluginDecorator of installPluginDecorators) {
      const installPluginArgs = pluginDecorator.bareFnArgs?.simplifiedValues;
      if (!installPluginArgs || !_.isArray(installPluginArgs) || installPluginArgs.length === 0) {
        dataSource._loadingError = new Error('expected @plugin args to be non-empty array');
        return;
      }
      const pluginSourceLocation = installPluginArgs[0];
      if (!_.isString(pluginSourceLocation)) {
        dataSource._loadingError = new Error('expected @plugin first arg to be string');
        return;
      }
      // install from relative path
      if (pluginSourceLocation.startsWith('./') || pluginSourceLocation.startsWith('../')) {
        if (!(dataSource instanceof FileBasedDataSource)) {
          dataSource._loadingError = new Error('@plugin with relative path can only be used from a file-based data source');
          return;
        }
        const fullPath = path.resolve(path.dirname(dataSource.fullPath), pluginSourceLocation);
        if (!(await pathExists(fullPath))) {
          console.log(pluginDecorator.data._location, getErrorLocation(dataSource, pluginDecorator));

          dataSource._loadingError = new SchemaError(`Bad @import - plugin file not found: ${fullPath}`, {
            location: getErrorLocation(dataSource, pluginDecorator),
          });
          return;
        }

        console.log('>> running imported plugin code', fullPath);
        // await import(fullPath);

        // const pluginSrc = await readFile(fullPath, 'utf-8');
        // await loadPluginFromSrc(pluginSrc);

        dataSource.plugins ||= [];
        dataSource.plugins.push(await VarlockPlugin.init(fullPath));

        console.log('<< done importing plugin');
      } else if (pluginSourceLocation.startsWith('http://')) {
        dataSource._loadingError = new Error('http imports must be over https');
        return;
      } else if (pluginSourceLocation.startsWith('https://')) {
        const localPath = await downloadPlugin(pluginSourceLocation);
        dataSource.plugins ||= [];
        dataSource.plugins.push(await VarlockPlugin.init(localPath));
      } else if (pluginSourceLocation.startsWith('npm:')) {
        dataSource._loadingError = new Error('npm imports not supported yet');
        return;
      } else {
        dataSource._loadingError = new Error('unsupported plugin import type');
        return;
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
