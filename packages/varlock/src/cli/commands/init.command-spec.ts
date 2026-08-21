import { define } from 'gunshi';

export const commandSpec = define({
  name: 'init',
  description: 'Set up varlock in the current project',
  args: {
    agent: {
      type: 'boolean',
      description: 'Run in non-interactive mode for agent/automation workflows',
    },
  },
  examples: `
This command starts an interactive onboarding process to help you get started with Varlock.
It will:
  - Scan for existing .env files in your project
  - Help create a .env.schema file from your .env.example or .env.sample file
  - Install varlock as a dependency in package.json (if applicable)

📍 Run this command in directories that contain .env or .env.* files

Examples:
  varlock init                    # Run in the current directory
  varlock init --agent            # Run non-interactively (agent/automation friendly)
  cd path/to/your/project && varlock init

For more information, visit https://varlock.dev/getting-started/installation
  `.trim(),
});
