import { PostHog } from 'posthog-node';
import { homedir } from 'os';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

const POSTHOG_API_KEY = 'phc_bfzH97VIta8yQa8HrsgmitqS6rTydjMISs0m8aqJTnq';
const POSTHOG_HOST = 'https://ph.varlock.dev';

let posthog: PostHog | null = null;

async function isOptedOut(): Promise<boolean> {
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

export async function initAnalytics() {
  // Check if analytics is opted out
  if (await isOptedOut()) {
    return;
  }

  try {
    return new PostHog(POSTHOG_API_KEY, {
      host: POSTHOG_HOST,
    });
  } catch (error) {
    console.error('Failed to initialize PostHog:', error);
  }
}

export async function trackCommand(posthog: PostHog, command: string, properties?: Record<string, any>) {
  if (!posthog || await isOptedOut()) {
    return;
  }

  try {
    await posthog.capture({
      distinctId: 'anonymous',
      event: 'cli_command_executed',
      properties: {
        command,
        ...properties,
      },
    });

    await posthog.shutdown();
  } catch (error) {
    // Silently fail - we don't want analytics errors to affect the CLI
    console.debug('Failed to track command:', error);
  }
}

export async function trackInstall(posthog: PostHog, source: 'brew' | 'curl') {
  if (!posthog || await isOptedOut()) {
    return;
  }

  try {
    await posthog.capture({
      distinctId: 'anonymous',
      event: 'cli_install',
      properties: {
        source,
      },
    });

    await posthog.shutdown();
  } catch (error) {
    console.debug('Failed to track install:', error);
  }
}
