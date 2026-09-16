import {
  describe, expect, it, vi,
} from 'vitest';
import {
  isPreviewDeployCommand, resolvedCommandFromHelp, wranglerCommandArgs, wranglerFlagValue,
} from '../src/wrangler-command-detection';

const ESC = '\u001B';

// abbreviated real output from `wrangler <cmd> --help` (wrangler 4.93.0)
const DEPLOY_HELP = [
  'wrangler preview [script]',
  '',
  'Create a Preview deployment of the current Worker [private beta]',
  '',
  'POSITIONALS',
  '  script  The path to an entry point for your Worker  [string]',
].join('\n');
const SETTINGS_HELP = [
  'wrangler preview settings',
  '',
  'Show the current Previews settings for a Worker [private beta]',
].join('\n');
const SECRET_PUT_HELP = [
  'wrangler preview secret put <key>',
  '',
  "Create or update a secret in the Worker's Previews settings [private beta]",
].join('\n');
const PARSE_ERROR = [
  `${ESC}[31m✘ ${ESC}[41;31m[${ESC}[41;97mERROR${ESC}[41;31m]${ESC}[0m ${ESC}[1mUnknown arguments: nope${ESC}[0m`,
  '',
  'wrangler preview [script]',
].join('\n');

const helpRunner = (output: string | undefined) => vi.fn(async () => output);

describe('resolvedCommandFromHelp', () => {
  it('drops positional placeholders from the usage line', () => {
    expect(resolvedCommandFromHelp(DEPLOY_HELP)).toBe('preview');
    expect(resolvedCommandFromHelp(SECRET_PUT_HELP)).toBe('preview secret put');
  });

  it('reads nested subcommand paths', () => {
    expect(resolvedCommandFromHelp(SETTINGS_HELP)).toBe('preview settings');
    expect(resolvedCommandFromHelp('wrangler preview settings update\n\nUpdate...')).toBe('preview settings update');
  });

  it('strips ansi color codes', () => {
    expect(resolvedCommandFromHelp(`${ESC}[1mwrangler preview delete${ESC}[0m\n`)).toBe('preview delete');
  });

  it('returns undefined when the output is not a usage banner', () => {
    expect(resolvedCommandFromHelp(undefined)).toBeUndefined();
    expect(resolvedCommandFromHelp('')).toBeUndefined();
    expect(resolvedCommandFromHelp(PARSE_ERROR)).toBeUndefined();
    expect(resolvedCommandFromHelp('wrangler')).toBeUndefined();
  });
});

describe('isPreviewDeployCommand', () => {
  it.each([
    [['deploy'], 'a different command'],
    [['preview', '--help'], 'an explicit help request'],
    [['preview', '-h'], 'an explicit help request'],
  ])('does not ask wrangler about %j (%s)', async (args) => {
    const runWrangler = helpRunner(DEPLOY_HELP);
    expect(await isPreviewDeployCommand(args, runWrangler)).toBe(false);
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it.each([
    [['preview']],
    [['preview', '--json']],
    [['preview', '--name=my-branch']],
    // wrangler accepts global flags before the command
    [['--cwd=/app', 'preview']],
    [['--cwd=/app', '--json', 'preview', '--tag=x']],
    // `--` ends option parsing, so nothing after it can be a subcommand
    [['preview', '--', 'delete']],
  ])('routes %j through varlock without asking wrangler', async (args) => {
    const runWrangler = helpRunner(DEPLOY_HELP);
    expect(await isPreviewDeployCommand(args, runWrangler)).toBe(true);
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('asks wrangler to resolve ambiguous args, and deploys when it resolves to `preview`', async () => {
    const runWrangler = helpRunner(DEPLOY_HELP);
    // `delete` here is the value of --name, not a subcommand - only wrangler knows that
    expect(await isPreviewDeployCommand(['preview', '--name', 'delete'], runWrangler)).toBe(true);
    expect(runWrangler).toHaveBeenCalledWith(['preview', '--name', 'delete', '--help']);
  });

  it.each([
    [['preview', 'src/index.ts'], DEPLOY_HELP, true],
    [['preview', '--config', 'wrangler.jsonc'], DEPLOY_HELP, true],
    [['--cwd=/app', 'preview', 'src/index.ts'], DEPLOY_HELP, true],
    [['preview', 'settings'], SETTINGS_HELP, false],
    [['preview', '-c', 'wrangler.jsonc', 'settings'], SETTINGS_HELP, false],
    [['preview', 'secret', 'put', 'FOO'], SECRET_PUT_HELP, false],
    [['--cwd=/app', 'preview', 'delete'], 'wrangler preview delete\n', false],
  ])('resolves %j via wrangler', async (args, help, expected) => {
    expect(await isPreviewDeployCommand(args, helpRunner(help))).toBe(expected);
  });

  it('probes with the leading global flags included', async () => {
    const runWrangler = helpRunner(DEPLOY_HELP);
    await isPreviewDeployCommand(['--cwd=/app', 'preview', 'src/index.ts'], runWrangler);
    expect(runWrangler).toHaveBeenCalledWith(['--cwd=/app', 'preview', 'src/index.ts', '--help']);
  });

  it('passes through when wrangler cannot resolve the command', async () => {
    expect(await isPreviewDeployCommand(['preview', 'huh'], helpRunner(undefined))).toBe(false);
    expect(await isPreviewDeployCommand(['preview', '--nope', 'x'], helpRunner(PARSE_ERROR))).toBe(false);
  });
});

describe('wranglerCommandArgs', () => {
  it('returns the args from the command onwards', () => {
    expect(wranglerCommandArgs(['deploy', '--var', 'A:b'])).toEqual(['deploy', '--var', 'A:b']);
    expect(wranglerCommandArgs(['--cwd=/app', 'deploy'])).toEqual(['deploy']);
    expect(wranglerCommandArgs(['--cwd=/app', '--json', 'versions', 'upload'])).toEqual(['versions', 'upload']);
  });

  it('returns nothing when there is no command', () => {
    expect(wranglerCommandArgs([])).toEqual([]);
    expect(wranglerCommandArgs(['--version'])).toEqual([]);
  });
});

describe('wranglerFlagValue', () => {
  it('reads both the joined and separated forms', () => {
    expect(wranglerFlagValue(['--cwd=/app', 'deploy'], '--cwd')).toBe('/app');
    expect(wranglerFlagValue(['deploy', '--cwd', '/app'], '--cwd')).toBe('/app');
    expect(wranglerFlagValue(['preview', '--cwd=/app', '--json'], '--cwd')).toBe('/app');
  });

  it('returns undefined when the flag is absent', () => {
    expect(wranglerFlagValue(['deploy'], '--cwd')).toBeUndefined();
    expect(wranglerFlagValue(['deploy', '--cwdx=/app'], '--cwd')).toBeUndefined();
  });

  it('ignores anything after the option terminator', () => {
    expect(wranglerFlagValue(['deploy', '--', '--cwd=/app'], '--cwd')).toBeUndefined();
  });
});
