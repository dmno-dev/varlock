import { define } from 'gunshi';

export const commandSpec = define({
  name: 'install-plugin',
  description: 'Download and cache a plugin from npm for use with the standalone binary',
  args: {
    plugin: {
      type: 'positional',
      description: 'Plugin to install, in the format name@version (e.g. my-plugin@1.2.3)',
    },
  },
  examples: `
Pre-downloads a plugin into the local varlock plugin cache so it is available without
needing an interactive confirmation prompt. This is useful in CI environments or any
other non-interactive workflow where the standalone binary is used.

The plugin must be specified with an exact version number.

Examples:
  varlock install-plugin my-plugin@1.2.3
  varlock install-plugin @my-scope/my-plugin@2.0.0
`.trim(),
});
