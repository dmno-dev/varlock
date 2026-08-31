import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';

vi.mock('./helpers/telemetry', () => ({
  trackCommand: vi.fn(async () => { /* no-op */ }),
}));

import { cli, define } from 'gunshi';
import { trackCommand } from './helpers/telemetry';
import { commandTelemetry } from './command-telemetry-plugin';

// A real gunshi run, not a hand-rolled fake: the whole point of the plugin is that gunshi
// dispatches nested subcommands straight to the leaf, so only the real dispatcher proves it.
const startCommand = define({ name: 'start', run: () => { /* no-op */ } });
const runCommand = define({
  name: 'run',
  run: () => { throw new Error('command blew up'); },
});
const proxyCommand = define({
  name: 'proxy',
  subCommands: { start: startCommand, run: runCommand },
  run: () => { /* no-op */ },
});
const loadCommand = define({ name: 'load', run: () => { /* no-op */ } });
const completeCommand = define({ name: 'complete', run: () => { /* no-op */ } });

async function invoke(args: Array<string>) {
  const subCommands = new Map<string, any>([
    ['proxy', proxyCommand],
    ['load', loadCommand],
    ['complete', completeCommand],
  ]);
  try {
    await cli(args, { run: () => { /* no-op */ } }, {
      name: 'varlock',
      version: '0.0.0-test',
      subCommands,
      plugins: [commandTelemetry()],
      usageSilent: true,
    });
  } catch {
    // command errors are irrelevant here - we only care about what was tracked
  }
}

const trackedCommands = () => vi.mocked(trackCommand).mock.calls.map((call) => call[0]);

describe('command telemetry plugin', () => {
  beforeEach(() => {
    vi.mocked(trackCommand).mockClear();
  });

  it('tracks a nested subcommand by its full path', async () => {
    await invoke(['proxy', 'start']);
    expect(trackedCommands()).toEqual(['proxy start']);
  });

  it('tracks a top-level command', async () => {
    await invoke(['load']);
    expect(trackedCommands()).toEqual(['load']);
  });

  it('tracks a bare parent command', async () => {
    await invoke(['proxy']);
    expect(trackedCommands()).toEqual(['proxy']);
  });

  it('tracks before the command runs, so a throwing command is still counted', async () => {
    await invoke(['proxy', 'run']);
    expect(trackedCommands()).toEqual(['proxy run']);
  });

  it('does not track help or version, which short-circuit before the command', async () => {
    await invoke(['load', '--help']);
    await invoke(['proxy', 'start', '--help']);
    await invoke(['--version']);
    expect(trackedCommands()).toEqual([]);
  });

  it('does not track bare `varlock` or shell completion', async () => {
    await invoke([]);
    // registered by @gunshi/plugin-completion and invoked on every tab-press
    await invoke(['complete']);
    expect(trackedCommands()).toEqual([]);
  });
});
