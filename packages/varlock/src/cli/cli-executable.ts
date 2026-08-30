import { cli, lazy } from 'gunshi';
import completion from '@gunshi/plugin-completion';
import { gracefulExit } from 'exit-hook';

import { handleBrokenPipe } from './helpers/broken-pipe';
import { commandTelemetry } from './command-telemetry-plugin';

import { VARLOCK_BANNER_COLOR } from '../lib/ascii-art';
import { CliExitError } from './helpers/exit-error';
import { fmt } from './helpers/pretty-format';
import { trackCommand, trackInstall } from './helpers/telemetry';
import { InvalidEnvError } from './helpers/invalid-env-error';
import { isArgError, toCliExitError } from './helpers/arg-errors';
import { checkBunVersion } from '../lib/check-bun-version';
import { checkLocalVersionMismatch } from '../lib/check-local-version';
import packageJson from '../../package.json';
import { enforceProxyContextGuards } from './helpers/proxy-context-guard';

// Only the spec (name/description/args/examples) is imported eagerly - each command's
// implementation lives in a sibling `*.command.ts` that is pulled in via a dynamic
// import when that command actually runs. Keeping the two in separate modules is what
// makes the split real: importing anything from `*.command.ts` here would drag the whole
// implementation into the entry chunk and collapse the dynamic import away.
import { commandSpec as initCommandSpec } from './commands/init.command-spec';
import { commandSpec as loadCommandSpec } from './commands/load.command-spec';
import { commandSpec as runCommandSpec } from './commands/run.command-spec';
import { commandSpec as printenvCommandSpec } from './commands/printenv.command-spec';
import { commandSpec as encryptCommandSpec } from './commands/encrypt.command-spec';
import { commandSpec as lockCommandSpec } from './commands/lock.command-spec';
import { commandSpec as revealCommandSpec } from './commands/reveal.command-spec';
// import { commandSpec as doctorCommandSpec } from './commands/doctor.command-spec';
import { commandSpec as helpCommandSpec } from './commands/help.command-spec';
import { commandSpec as telemetryCommandSpec } from './commands/telemetry.command-spec';
import { commandSpec as explainCommandSpec } from './commands/explain.command-spec';
import { commandSpec as flattenCommandSpec } from './commands/flatten.command-spec';
import { commandSpec as freezeCommandSpec } from './commands/freeze.command-spec';
import { commandSpec as scanCommandSpec } from './commands/scan.command-spec';
import { commandSpec as codegenCommandSpec } from './commands/codegen.command-spec';
import { commandSpec as typegenCommandSpec } from './commands/typegen.command-spec';
import { commandSpec as installPluginCommandSpec } from './commands/install-plugin.command-spec';
import { commandSpec as auditCommandSpec } from './commands/audit.command-spec';
import { commandSpec as generateKeyCommandSpec } from './commands/generate-key.command-spec';
import { commandSpec as cacheCommandSpec } from './commands/cache.command-spec';
import { commandSpec as keychainCommandSpec } from './commands/keychain.command-spec';
import { commandSpec as proxyCommandSpec } from './commands/proxy.command-spec';
// import { commandSpec as loginCommandSpec } from './commands/login.command-spec';
// import { commandSpec as pluginCommandSpec } from './commands/plugin.command-spec';

// must happen before anything writes to stdio
handleBrokenPipe();

let versionId = packageJson.version;
if (__VARLOCK_BUILD_TYPE__ !== 'release') versionId += `-${__VARLOCK_BUILD_TYPE__}`;

const subCommands = new Map();
subCommands.set('init', lazy(async () => (await import('./commands/init.command')).commandFn, initCommandSpec));
subCommands.set('load', lazy(async () => (await import('./commands/load.command')).commandFn, loadCommandSpec));
subCommands.set('run', lazy(async () => (await import('./commands/run.command')).commandFn, runCommandSpec));
subCommands.set('printenv', lazy(async () => (await import('./commands/printenv.command')).commandFn, printenvCommandSpec));
subCommands.set('encrypt', lazy(async () => (await import('./commands/encrypt.command')).commandFn, encryptCommandSpec));
subCommands.set('lock', lazy(async () => (await import('./commands/lock.command')).commandFn, lockCommandSpec));
subCommands.set('reveal', lazy(async () => (await import('./commands/reveal.command')).commandFn, revealCommandSpec));
// subCommands.set('doctor', lazy(async () => (await import('./commands/doctor.command')).commandFn, doctorCommandSpec));
subCommands.set('explain', lazy(async () => (await import('./commands/explain.command')).commandFn, explainCommandSpec));
subCommands.set('flatten', lazy(async () => (await import('./commands/flatten.command')).commandFn, flattenCommandSpec));
subCommands.set('freeze', lazy(async () => (await import('./commands/freeze.command')).commandFn, freezeCommandSpec));
subCommands.set('help', lazy(async () => (await import('./commands/help.command')).commandFn, helpCommandSpec));
subCommands.set('telemetry', lazy(async () => (await import('./commands/telemetry.command')).commandFn, telemetryCommandSpec));
subCommands.set('scan', lazy(async () => (await import('./commands/scan.command')).commandFn, scanCommandSpec));
subCommands.set('audit', lazy(async () => (await import('./commands/audit.command')).commandFn, auditCommandSpec));
subCommands.set('codegen', lazy(async () => (await import('./commands/codegen.command')).commandFn, codegenCommandSpec));
subCommands.set('typegen', lazy(async () => (await import('./commands/typegen.command')).commandFn, typegenCommandSpec));
subCommands.set('install-plugin', lazy(async () => (await import('./commands/install-plugin.command')).commandFn, installPluginCommandSpec));
subCommands.set('generate-key', lazy(async () => (await import('./commands/generate-key.command')).commandFn, generateKeyCommandSpec));
subCommands.set('cache', lazy(async () => (await import('./commands/cache.command')).commandFn, cacheCommandSpec));
subCommands.set('keychain', lazy(async () => (await import('./commands/keychain.command')).commandFn, keychainCommandSpec));
subCommands.set('proxy', lazy(async () => (await import('./commands/proxy.command')).commandFn, proxyCommandSpec));
// subCommands.set('login', lazy(async () => (await import('./commands/login.command')).commandFn, loginCommandSpec));
// subCommands.set('plugin', lazy(async () => (await import('./commands/plugin.command')).commandFn, pluginCommandSpec));

(async function go() {
  try {
    try {
      checkBunVersion();
    } catch (e) {
      throw new CliExitError((e as Error).message, { forceExit: true });
    }

    let args = process.argv.slice(2);

    // TODO: remove this once we have a better way to re-trigger help
    if (args[0] === 'help') args = ['--help'];

    const isCompletionInvoke = args[0] === 'complete';

    // track standalone installs via homebrew/curl
    if (__VARLOCK_SEA_BUILD__) {
      if (args[0] === '--post-install') {
        await trackInstall(args[1] as 'brew' | 'curl');
        //! this ouput is used by homebrew formula to check installed version is correct
        console.log(versionId);
        gracefulExit();
      }
    }

    if (args[0] === '--version') {
      await trackCommand('version');
    }

    await enforceProxyContextGuards(args);

    // warn if standalone binary version differs from local node_modules install
    // skip for --version/--help/complete since those are quick informational commands
    if (__VARLOCK_SEA_BUILD__ && args[0] !== '--version' && args[0] !== '--help' && !isCompletionInvoke) {
      const versionMismatchWarning = checkLocalVersionMismatch(packageJson.version);
      if (versionMismatchWarning) {
        console.warn(`\n⚠️  ${versionMismatchWarning}\n`);
      }
    }

    await cli(args, {
      // main command - triggered if you just run `varlock` with no args
      run: () => {
        console.log('Please run one of the sub-commands. Run `varlock --help` for more info.');
      },
    }, {
      name: 'varlock',
      description: 'Encrypt and protect your env vars',
      version: versionId,
      subCommands,
      plugins: [completion(), commandTelemetry()],
      // reject unknown/misspelled flags instead of silently dropping them
      strict: true,
      // gunshi renders validation errors to stdout, which would corrupt the output of
      // commands like `varlock load`. Suppress it and format them ourselves in the catch
      // below, so every failure looks the same and goes to stderr.
      renderValidationErrors: null,
      renderHeader: async (ctx) => {
        // do not show header if we are running a sub-command
        if (ctx.name) return '';
        return VARLOCK_BANNER_COLOR;
      },
    });
    // Short delay before exit to work around a libuv bug on Windows where
    // uv_async_send is called after uv_close during shutdown, causing a crash.
    // See: https://github.com/nodejs/node/issues/56645
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    gracefulExit();
  } catch (error) {
    if (isArgError(error)) {
      console.error(toCliExitError(error, process.argv.slice(2)).getFormattedOutput());
    } else if (error instanceof Error && error.message.startsWith('Command not found: ')) {
      const badCommandName = error.message.split(': ')[1];
      const badCommandErr = new CliExitError(`Invalid subcommand: ${badCommandName}`, {
        suggestion: `Run \`${fmt.command('varlock --help', { jsPackageManager: true })}\` for more info.`,
      });
      console.error(badCommandErr.getFormattedOutput());
    } else if (error instanceof CliExitError || error instanceof InvalidEnvError) {
      // in watch mode, we just log but do not actually exit
      console.error(error.getFormattedOutput());
      // TODO: we'll probably want to implement watch mode, so it wont actually exit
      // process.exit(1);
    } else {
      throw error;
    }

    // Same Windows libuv workaround as the success path above
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    gracefulExit(1);
  }
}());
