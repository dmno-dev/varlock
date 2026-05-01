import ansis from 'ansis';
import { define } from 'gunshi';
import { isCancel } from '@clack/prompts';
import { gracefulExit } from 'exit-hook';

import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForSchemaErrors, checkForNoEnvFiles } from '../helpers/error-checks';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { CliExitError } from '../helpers/exit-error';
import { select } from '../helpers/prompts';
import { ConfigItem } from '../../env-graph';
import { redactString } from '../../runtime/lib/redaction';

export const commandSpec = define({
  name: 'reveal',
  description: 'Securely view decrypted values of sensitive environment variables',
  args: {
    copy: {
      type: 'boolean',
      description: 'Copy the value to clipboard instead of displaying (auto-clears after 10s)',
    },
    path: {
      type: 'string',
      short: 'p',
      multiple: true,
      description: 'Path to a specific .env file or directory to use as the entry point (can be specified multiple times)',
    },
    env: {
      type: 'string',
      description: 'Set the environment (e.g., production, development, etc)',
    },
  },
  examples: `
Securely view the plaintext value of sensitive environment variables.
Values are shown in an alternate screen buffer so they don't persist in
terminal scrollback history.

Examples:
  varlock reveal                  # Interactive picker to select and reveal values
  varlock reveal MY_SECRET        # Reveal a specific variable
  varlock reveal MY_SECRET --copy # Copy value to clipboard (auto-clears after 10s)
`.trim(),
});

const CLIPBOARD_CLEAR_DELAY_MS = 10_000;

async function copyToClipboard(text: string): Promise<void> {
  const { execSync } = await import('node:child_process');
  const platform = process.platform;

  if (platform === 'darwin') {
    execSync('pbcopy', { input: text });
  } else if (platform === 'linux') {
    // try xclip first, then xsel
    try {
      execSync('xclip -selection clipboard', { input: text });
    } catch {
      execSync('xsel --clipboard --input', { input: text });
    }
  } else if (platform === 'win32') {
    execSync('clip', { input: text });
  } else {
    throw new CliExitError('Clipboard not supported on this platform');
  }
}

async function clearClipboard(): Promise<void> {
  const { execSync } = await import('node:child_process');
  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      execSync('pbcopy', { input: '' });
    } else if (platform === 'linux') {
      try {
        execSync('xclip -selection clipboard', { input: '' });
      } catch {
        execSync('xsel --clipboard --input', { input: '' });
      }
    } else if (platform === 'win32') {
      execSync('echo. | clip', { shell: 'cmd.exe' });
    }
  } catch {
    // best effort
  }
}

function enterAltScreen() {
  process.stdout.write('\x1b[?1049h'); // switch to alternate screen buffer
  process.stdout.write('\x1b[H'); // move cursor to top-left
}

function exitAltScreen() {
  process.stdout.write('\x1b[?1049l'); // switch back to main screen buffer
}

/** Wait for a single keypress, returns the key */
async function waitForKeypress(): Promise<string> {
  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      resolve(data.toString());
    });
  });
}

function displayRevealedValue(item: ConfigItem) {
  enterAltScreen();

  const value = item.resolvedValue;
  const valStr = value === undefined || value === null ? ansis.gray('(empty)') : String(value);

  console.log('');
  console.log(ansis.bold.cyan(`  ${item.key}`));
  if (item.description) {
    console.log(ansis.gray(`  ${item.description}`));
  }
  console.log('');
  console.log(`  ${valStr}`);
  console.log('');
  console.log(ansis.gray('  Press any key to hide...'));
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  const { copy: copyMode } = ctx.values;

  const envGraph = await loadVarlockEnvGraph({
    currentEnvFallback: ctx.values.env,
    entryFilePaths: ctx.values.path,
  });

  checkForSchemaErrors(envGraph);
  checkForNoEnvFiles(envGraph);

  await envGraph.resolveEnvValues();

  // Collect sensitive items
  const sensitiveItems: Array<ConfigItem> = [];
  for (const itemKey of envGraph.sortedConfigKeys) {
    const item = envGraph.configSchema[itemKey];
    if (item.isSensitive && item.resolvedValue !== undefined) {
      sensitiveItems.push(item);
    }
  }

  if (sensitiveItems.length === 0) {
    console.log('No sensitive values found to reveal.');
    return;
  }

  // Check if a specific variable was requested via positional arg
  const positionals = (ctx.positionals ?? []).slice(ctx.commandPath?.length ?? 0);
  const requestedVar = positionals[0];

  if (requestedVar) {
    // Direct reveal of a specific variable
    const item = sensitiveItems.find((i) => i.key === requestedVar);
    if (!item) {
      // Check if it exists but isn't sensitive
      if (requestedVar in envGraph.configSchema) {
        throw new CliExitError(`"${requestedVar}" is not marked as sensitive`, {
          suggestion: 'Use `varlock printenv` for non-sensitive values.',
        });
      }
      throw new CliExitError(`Variable "${requestedVar}" not found in schema`);
    }

    if (copyMode) {
      await copyToClipboard(String(item.resolvedValue ?? ''));
      console.log(`\n  Copied ${ansis.cyan(item.key)} to clipboard.`);
      console.log(ansis.gray(`  Clipboard will be cleared in ${CLIPBOARD_CLEAR_DELAY_MS / 1000}s.\n`));
      setTimeout(async () => {
        await clearClipboard();
        console.log(ansis.gray('  Clipboard cleared.'));
        gracefulExit();
      }, CLIPBOARD_CLEAR_DELAY_MS);
      return;
    }

    displayRevealedValue(item);
    await waitForKeypress();
    exitAltScreen();
    return;
  }

  // Interactive picker loop
  while (true) {
    const selected = await select<string>({
      message: `Select a variable to reveal ${ansis.gray('(use arrows, enter to select)')}`,
      options: sensitiveItems.map((item) => ({
        value: item.key,
        label: item.key,
        hint: redactString(String(item.resolvedValue ?? '')) ?? undefined,
      })),
    });

    if (isCancel(selected)) return gracefulExit();

    const item = sensitiveItems.find((i) => i.key === selected)!;

    if (copyMode) {
      await copyToClipboard(String(item.resolvedValue ?? ''));
      console.log(`\n  Copied ${ansis.cyan(item.key)} to clipboard.`);
      console.log(ansis.gray(`  Clipboard will be cleared in ${CLIPBOARD_CLEAR_DELAY_MS / 1000}s.\n`));
      setTimeout(async () => {
        await clearClipboard();
        console.log(ansis.gray('  Clipboard cleared.'));
        gracefulExit();
      }, CLIPBOARD_CLEAR_DELAY_MS);
      return;
    }

    displayRevealedValue(item);
    await waitForKeypress();
    exitAltScreen();

    // Loop back to the picker to reveal another value
  }
};
