import os from 'node:os';
import crypto, { type BinaryLike, createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  existsSync, readFileSync, writeFileSync,
  mkdirSync,
} from 'node:fs';
import { asyncExitHook } from 'exit-hook';
import Debug from 'debug';
import { name as ciName, isCI } from 'ci-info';
import isDocker from 'is-docker';
import isWSL from 'is-wsl';


import packageJson from '../../../package.json';

import { CONFIG } from '../../config';


const debug = Debug('varlock:telemetry');

const TRUE_ENV_VAR_VALUES = ['true', '1', 't'];

const varlockConfigDirPath = join(os.homedir(), '.varlock');
const varlockConfigFilePath = join(varlockConfigDirPath, 'config.json');
let varlockConfigFileContents: Record<string, any> | undefined;
function getConfigFileContents() {
  if (varlockConfigFileContents) return varlockConfigFileContents;
  try {
    const configContent = readFileSync(varlockConfigFilePath, 'utf-8');
    varlockConfigFileContents = JSON.parse(configContent);
    return varlockConfigFileContents;
  } catch (error) {
    debug('Failed to read varlock config:', error);
    return {};
  }
}

// we will identify users using a random UUID stored in the `~/.varlock/config.json` file
let cachedAnonymousId: string | undefined;
function getAnonymousId() {
  if (cachedAnonymousId) return cachedAnonymousId;

  const configFileContents = getConfigFileContents();
  if (configFileContents?.anonymousId) {
    cachedAnonymousId = configFileContents.anonymousId;
    return configFileContents.anonymousId;
  }

  const newAnonymousId = `${isCI ? 'ci-' : ''}${crypto.randomUUID()}`;

  if (!existsSync(varlockConfigDirPath)) {
    mkdirSync(varlockConfigDirPath, { recursive: true });
  }

  writeFileSync(
    varlockConfigFilePath,
    JSON.stringify({
      ...configFileContents,
      anonymousId: newAnonymousId,
    }, null, 2),
    { flag: 'w' },
  );
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
    || TRUE_ENV_VAR_VALUES.includes((process.env.VARLOCK_TELEMETRY_DISABLED || '').toLowerCase())
  ) {
    debug('telemetry opted out - env var');
    return true;
  }

  // Check config file
  const varlockConfigFile = getConfigFileContents();
  if (varlockConfigFile?.analytics_opt_out || varlockConfigFile?.telemetryDisabled) {
    debug('telemetry opted out - config file');
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
  try {
    // Find the git directory by scanning upwards
    let gitDirPath: string | undefined;
    let currentDir = process.cwd();
    while (currentDir && currentDir !== '/') {
      const possibleGitDirPath = join(currentDir, '.git');
      if (existsSync(possibleGitDirPath)) {
        gitDirPath = possibleGitDirPath;
        break;
      }
      currentDir = join(currentDir, '..');
    }
    if (!gitDirPath) return undefined;
    const gitConfigContents = readFileSync(join(gitDirPath, 'config'), 'utf-8');
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
    distinct_id: getAnonymousId(),
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

