import os from 'node:os';
import crypto, { type BinaryLike, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  existsSync, readFileSync, writeFileSync,
  mkdirSync,
} from 'node:fs';
import { asyncExitHook, gracefulExit } from 'exit-hook';
import Debug from 'debug';
import { name as ciName, isCI } from 'ci-info';
import isDocker from 'is-docker';
import isWSL from 'is-wsl';


import packageJson from '../../../package.json';

import { CONFIG } from '../../config';


const debug = Debug('varlock:telemetry');

const TRUE_ENV_VAR_VALUES = ['true', '1', 't'];


const userVarlockDirPath = join(os.homedir(), '.varlock');
const userVarlockConfigFilePath = join(userVarlockDirPath, 'config.json');
let userVarlockConfig: Record<string, any> | undefined;
let projectVarlockConfig: Record<string, any> | undefined;
let mergedVarlockConfigFileContents: Record<string, any> | undefined;


let _gitDirPath: string | undefined;
let _varlockDirPath: string | undefined; // can be above the project root, but we'll still respect it
let _projectRootDirPath: string | undefined;
let _foundProjectRoot: boolean = false;
/**
 * walks up the directory tree looking for .git and .varlock folders
 * ideally this helps make sure we only walk up the folder tree once
 * */
function findProjectDirs() {
  if (!_foundProjectRoot) {
    let currentDir = process.cwd();
    while (currentDir) {
      const possibleGitDirPath = join(currentDir, '.git');
      if (!_gitDirPath && existsSync(possibleGitDirPath)) {
        _gitDirPath = possibleGitDirPath;
      }

      // currently we assume a .varlock folder is in the project root
      // and we do not allow a monorepo to have multiple .varlock folders
      const possibleVarlockDirPath = join(currentDir, '.varlock');
      if (
        !_varlockDirPath
        && possibleVarlockDirPath !== userVarlockDirPath // ignore if we are at ~/.varlock
        && existsSync(possibleVarlockDirPath)
      ) {
        _varlockDirPath = possibleVarlockDirPath;
      }

      // this will stop when we reach the top
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }

    if (_gitDirPath) _projectRootDirPath = dirname(_gitDirPath);
    else if (_varlockDirPath) _projectRootDirPath = dirname(_varlockDirPath);
    else _projectRootDirPath = process.cwd();

    _foundProjectRoot = true;
  }
  return {
    gitDirPath: _gitDirPath,
    varlockDirPath: _varlockDirPath,
    projectRootDirPath: _projectRootDirPath,
  };
}

function loadVarlockConfig() {
  if (mergedVarlockConfigFileContents) return mergedVarlockConfigFileContents;

  // load user config file - ~/.varlock/config.json
  try {
    const userConfigStr = readFileSync(userVarlockConfigFilePath, 'utf-8');
    userVarlockConfig = userConfigStr.trim() ? JSON.parse(userConfigStr) : undefined;
  } catch (err) {
    // file does not exist (we jsut do this to avoid doing an extra step to check)
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      debug(`User varlock config file not found - ${userVarlockConfigFilePath}`);
    } else if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in project varlock config - ${userVarlockConfigFilePath}`, { cause: err });
    } else {
      throw new Error(`Problem reading project varlock config - ${userVarlockConfigFilePath}`, { cause: err });
    }
  }

  // loads project .varlock config (could be any ancestor of the folder **/.varlock/config.json)
  const { varlockDirPath } = findProjectDirs();
  if (varlockDirPath) {
    const projectVarlockConfigPath = join(varlockDirPath, 'config.json');
    try {
      const projectConfigStr = readFileSync(projectVarlockConfigPath, 'utf-8');
      projectVarlockConfig = projectConfigStr.trim() ? JSON.parse(projectConfigStr) : undefined;
    } catch (err) {
      // file does not exist (we jsut do this to avoid doing an extra step to check)
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        debug(`Project varlock config file not found - ${projectVarlockConfigPath}`);
      } else if (err instanceof SyntaxError) {
        throw new Error(`Invalid JSON in project varlock config - ${projectVarlockConfigPath}`, { cause: err });
      } else {
        throw new Error(`Problem reading project varlock config - ${projectVarlockConfigPath}`, { cause: err });
      }
    }
    if (projectVarlockConfig?.anonymousId) throw new Error('Anonymous ID should not be set in project varlock config');
  }

  // merge together - we may need more complex merging logic if we have nested config in the future
  mergedVarlockConfigFileContents = {
    ...userVarlockConfig,
    ...projectVarlockConfig,
  };

  return mergedVarlockConfigFileContents;
}
// we will identify users using a random UUID stored in the `~/.varlock/config.json` file
let cachedAnonymousId: string | undefined;
function getAnonymousId() {
  if (cachedAnonymousId) return cachedAnonymousId;

  const varlockConfig = loadVarlockConfig();
  if (varlockConfig?.anonymousId) {
    cachedAnonymousId = varlockConfig.anonymousId;
    return varlockConfig.anonymousId;
  }

  // generate new anon ID and save in ~/.varlock/config.json
  const newAnonymousId = `${isCI ? 'ci-' : ''}${crypto.randomUUID()}`;

  try {
    if (!existsSync(userVarlockDirPath)) {
      mkdirSync(userVarlockDirPath, { recursive: true });
    }

    writeFileSync(
      userVarlockConfigFilePath,
      JSON.stringify({
        ...userVarlockConfig,
        anonymousId: newAnonymousId,
      }, null, 2),
      { flag: 'w' },
    );
  } catch (err) {
    // known case when running within Docker and have no HOME folder set
    if (os.homedir() === '/dev/null') {
      console.error([
        'Your HOME directory is not set - probably because you are running within Docker.',
        'Please set HOME within your Dockerfile to a writable directory.',
        'For example: `ENV HOME=/app/.home` (or whatever directory you want to use).',
      ].join('\n'));
    } else {
      console.error([
        'There was a problem writing to the ~/.varlock folder',
        (err as Error).message,
        'Please ensure your home folder (or at least the ~/.varlock folder) is writable',
      ].join('\n'));
    }
    gracefulExit(1);
  }
  cachedAnonymousId = newAnonymousId;
  return newAnonymousId;
}


function checkIsOptedOut() {
  // Check if this is a dev build, rather than a published npm package or standalone binary
  if (__VARLOCK_BUILD_TYPE__ === 'dev') {
    debug('telemetry opted out - dev build');
    return true;
  }

  // Check environment variable
  if (
    process.env.PH_OPT_OUT === 'true' // legacy
    || (
      process.env.VARLOCK_TELEMETRY_DISABLED
      && TRUE_ENV_VAR_VALUES.includes(process.env.VARLOCK_TELEMETRY_DISABLED.toLowerCase())
    )
  ) {
    debug('telemetry opted out - env var');
    return true;
  }

  // Check config file(s)
  const varlockConfig = loadVarlockConfig();
  if (
    varlockConfig?.analytics_opt_out // legacy
    || varlockConfig?.telemetryDisabled
  ) {
    debug(`telemetry opted out - config file (${projectVarlockConfig?.telemetryDisabled ? 'project' : 'user'} config)`);
    return true;
  }
  return false;
}



function anonymizeValue(payload: BinaryLike): string {
  // We use empty string to represent an empty value. Avoid hashing this
  // since that would create a real hash and remove its "empty" meaning.
  if (payload === '') {
    return payload;
  }
  // Otherwise, create a new hash from the payload and return it.
  const hash = createHash('sha256');
  hash.update(payload);
  return hash.digest('hex');
}

function getProjectGitRemoteUrl(): string | undefined {
  findProjectDirs(); // finds the git folder
  if (!_gitDirPath) return undefined;
  try {
    const gitConfigContents = readFileSync(join(_gitDirPath, 'config'), 'utf-8');
    // first look for upstream
    const remoteUpstreamPos = gitConfigContents.indexOf('[remote "upstream"]');
    if (remoteUpstreamPos !== -1) {
      const remoteUpstreamUrl = gitConfigContents.slice(remoteUpstreamPos).match(/url = (.+)/)?.[1];
      return remoteUpstreamUrl;
    }
    // otherwise fallback to origin
    const remoteOriginPos = gitConfigContents.indexOf('[remote "origin"]');
    if (remoteOriginPos === -1) return undefined;
    const remoteOriginUrl = gitConfigContents.slice(remoteOriginPos).match(/url = (.+)/)?.[1];
    return remoteOriginUrl;
  } catch (err) {
    return undefined;
  }
}
function getAnonymousProjectId() {
  // we want a project ID tied to the git repo, so we can group telemetry data by project
  // we could use the first commit hash, but this is more costly to compute, as we either need to rely
  // on the git cli and execSync, or we need to parse the git objects directly
  // so for now, we'll use the git remote URL (upstream if it exists, or origin)
  const gitRemoteUrl = getProjectGitRemoteUrl();
  if (!gitRemoteUrl) return null;
  return anonymizeValue(gitRemoteUrl);
}


type TelemetryMeta = {
  // project info
  anonymous_project_id: string | null;
  // version information
  node_version: string;
  varlock_version: string;
  // OS information
  system_platform: string;
  system_release: string;
  system_architecture: string;
  // Machine information
  cpu_count: number,
  cpu_model: string | null,
  cpu_speed: number | null,
  memory_mb: number,
  // Environment information
  is_docker: boolean,
  is_tty: boolean,
  is_wsl: boolean,
  is_ci: boolean,
  ci_name: string | null,
  is_sea: boolean,
};

let cachedTelemetryMetadata: TelemetryMeta | undefined;
function getTelemetryMeta() {
  if (cachedTelemetryMetadata) return cachedTelemetryMetadata;

  const cpus = os.cpus() || [];

  let versionIdentifier = packageJson.version;
  // TODO: for preview builds, it would be nice to track which preview it is (PR number or commit hash)
  if (__VARLOCK_BUILD_TYPE__ !== 'release') versionIdentifier += `-${__VARLOCK_BUILD_TYPE__}`;

  cachedTelemetryMetadata = {
    anonymous_project_id: getAnonymousProjectId(),
    node_version: process.version.replace(/^v?/, ''),
    varlock_version: versionIdentifier,
    // TODO: pass through version info for specific integrations/plugins?
    system_platform: os.platform(),
    system_release: os.release(),
    system_architecture: os.arch(),
    cpu_count: cpus.length,
    cpu_model: cpus.length ? cpus[0].model : null,
    cpu_speed: cpus.length ? cpus[0].speed : null,
    memory_mb: Math.trunc(os.totalmem() / 1024 ** 2),
    is_docker: isDocker(),
    is_tty: process.stdout.isTTY,
    is_wsl: isWSL,
    is_ci: isCI,
    ci_name: ciName,
    is_sea: __VARLOCK_SEA_BUILD__,
  };
  return cachedTelemetryMetadata;
}


const isOptedOut = checkIsOptedOut();

let lastTelemetryReq: Promise<any> | undefined;

async function posthogCapture(event: string, properties?: Record<string, any>) {
  const telemetryMeta = getTelemetryMeta();
  const payload = {
    api_key: CONFIG.POSTHOG_API_KEY,
    event,
    properties: {
      $process_person_profile: false,
      ...telemetryMeta,
      ...properties,
    },
    distinct_id: isOptedOut ? '---' : getAnonymousId(),
  };

  debug(`track${isOptedOut ? ' (disabled)' : ''}`, payload);

  if (isOptedOut) return;

  // add exit hook, so we can give the request a little time to finish
  const removeExitHook = asyncExitHook(async () => {
    // will still exit if the timeout is met, but will finish early if the request completes
    await lastTelemetryReq;
  }, { wait: 500 });

  // Make the fetch call
  lastTelemetryReq = fetch(`${CONFIG.POSTHOG_HOST}/i/v0/e/`, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: {
      'Content-Type': 'application/json',
    },
  })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return res.text();
    })
    .then((text) => debug('telemetry response:', text))
    .catch((error) => {
      debug('telemetry error:', error);
    })
    .finally(() => {
      removeExitHook();
    });
}



export async function trackCommand(command: string, properties?: Record<string, any>) {
  await posthogCapture('cli_command_executed', {
    command,
    ...properties,
  });
}

export async function trackInstall(source: 'brew' | 'curl') {
  await posthogCapture('cli_install', {
    source,
  });
}

