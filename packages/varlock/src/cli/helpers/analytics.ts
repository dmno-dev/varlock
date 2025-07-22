import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'node:fs';
import Debug from 'debug';

const debug = Debug('varlock:telemetry');

import { CONFIG } from '../../config';

const TRUE_ENV_VAR_VALUES = ['true', '1', 't'];

function checkIsOptedOut() {
  // Check environment variable first
  if (
    process.env.PH_OPT_OUT === 'true' // legacy
    || TRUE_ENV_VAR_VALUES.includes((process.env.b || '').toLowerCase())
  ) {
    return true;
  }

  // Then check config file
  const configPath = join(homedir(), '.varlock', 'config.json');
  if (existsSync(configPath)) {
    try {
      const configContent = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      return config.analytics_opt_out === true;
    } catch (error) {
      console.debug('Failed to read analytics config:', error);
    }
  }
  return false;
}



const isOptedOut = checkIsOptedOut();
debug('telemetry opted out?', isOptedOut);

async function posthogCapture(event: string, properties?: Record<string, any>) {
  if (isOptedOut) return;

  const payload = {
    api_key: CONFIG.POSTHOG_API_KEY,
    event,
    properties: {
      $process_person_profile: false,
      ...properties,
    },
    distinct_id: 'anonymous',
  };

  const res = await fetch(`${CONFIG.POSTHOG_HOST}/i/v0/e/`, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: {
      'Content-Type': 'application/json',
    },
  });
  debug('res', await res.text());
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

