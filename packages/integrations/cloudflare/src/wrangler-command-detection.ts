const PREVIEW_SUBCOMMANDS = ['delete', 'settings', 'secret', 'base-config'];

const GLOBAL_OPTIONS_WITH_VALUES = [
  '--config',
  '-c',
  '--cwd',
  '--env',
  '-e',
  '--env-file',
  '--profile',
];

export function isPreviewDeployCommand(args: Array<string>) {
  if (args[0] !== 'preview' || args.includes('--help') || args.includes('-h')) return false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return true;
    if (GLOBAL_OPTIONS_WITH_VALUES.includes(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return !PREVIEW_SUBCOMMANDS.includes(arg);
  }

  return true;
}
