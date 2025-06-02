import { homedir } from 'os';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

import { CONFIG } from '../../config';

async function checkIsOptedOut(): Promise<boolean> {
  // Check environment variable first
  if (process.env.PH_OPT_OUT === 'true') {
    return true;
  }

  // Then check config file
  const configPath = join(homedir(), '.varlock', 'config.json');
  if (existsSync(configPath)) {
    try {
      const configContent = await readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      return config.analytics_opt_out === true;
    } catch (error) {
      console.debug('Failed to read analytics config:', error);
    }
  }
  return false;
}

const DEBUG_PH = !!process.env.DEBUG_PH;

const isOptedOut = await checkIsOptedOut();
if (DEBUG_PH) console.log('posthog opted out: ', isOptedOut);

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
  if (DEBUG_PH) console.log('res', await res.text());
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

