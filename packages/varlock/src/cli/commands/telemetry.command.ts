import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { define } from 'gunshi';
import { TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { gracefulExit } from 'exit-hook';
import { fmt } from '../helpers/pretty-format';
import { CliExitError } from '../helpers/exit-error';


export const commandSpec = define({
  name: 'telemetry',
  description: 'Enable/disable anonymous usage analytics',
  args: {
    mode: {
      type: 'positional',
      description: '"enable" or "disable"',
    },
  },
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  // TODO: remove this when gunshi supports types/validation for positional args
  if (!['enable', 'disable'].includes(ctx.values.mode)) {
    throw new CliExitError('additional arg must be "enable" or "disable"', {
      forceExit: true,
    });
  }

  const configDir = join(homedir(), '.varlock');
  const configPath = join(configDir, 'config.json');

  try {
    // Create .varlock directory if it doesn't exist
    if (!existsSync(configDir)) {
      await mkdir(configDir, { recursive: true });
    }

    // Read existing config if it exists
    let config: Record<string, any> = {};
    if (existsSync(configPath)) {
      const configContent = await readFile(configPath, 'utf-8');
      config = JSON.parse(configContent);
    }

    // update config `telemetryDisabled` setting
    if (ctx.values.mode === 'disable') config.telemetryDisabled = true;
    else delete config.telemetryDisabled;
    await writeFile(configPath, JSON.stringify(config, null, 2));

    if (ctx.values.mode) {
      console.log('✅ Successfully enabled anonymous usage analytics');
    } else {
      console.log('✅ Successfully disabled anonymous usage analytics');
    }
    console.log('> saved in:', fmt.filePath(configPath));
  } catch (error) {
    console.error('Failed to opt out of analytics:', error);
    return gracefulExit(1);
  }
};
