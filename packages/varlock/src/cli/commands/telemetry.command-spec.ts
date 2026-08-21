import { define } from 'gunshi';

export const commandSpec = define({
  name: 'telemetry',
  description: 'Enable/disable anonymous usage analytics',
  args: {
    mode: {
      type: 'positional',
      description: '"enable" or "disable"',
    },
  },
  examples: `
Opts in/out of anonymous usage analytics. This command creates/updates a configuration
file at $XDG_CONFIG_HOME/varlock/config.json (or ~/.config/varlock/config.json) saving
your preference.

Examples:
  varlock telemetry disable    # Opt out of telemetry
  varlock telemetry enable     # Opt in to telemetry

💡 Tip: You can also temporarily opt out by setting VARLOCK_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1
For more information, visit https://varlock.dev/guides/telemetry/
  `.trim(),
});
