import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { define } from 'gunshi';
import { TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';


export const commandSpec = define({
  name: 'opt-out',
  description: 'Opt out of anonymous usage analytics',
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const configDir = join(homedir(), '.varlock');
  const configPath = join(configDir, 'config.json');

  try {
    // Create .varlock directory if it doesn't exist
    if (!existsSync(configDir)) {
      await mkdir(configDir, { recursive: true });
    }

    // Read existing config if it exists
    let config = {};
    if (existsSync(configPath)) {
      const configContent = await readFile(configPath, 'utf-8');
      config = JSON.parse(configContent);
    }

    // Update config with opt-out setting
    config = {
      ...config,
      analytics_opt_out: true,
    };

    // Write updated config
    await writeFile(configPath, JSON.stringify(config, null, 2));

    console.log('✅ Successfully opted out of anonymous usage analytics');
    console.log('This setting is stored in:', configPath);
  } catch (error) {
    console.error('Failed to opt out of analytics:', error);
    process.exit(1);
  }
};
