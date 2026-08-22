import type { StarlightUserConfig } from '@astrojs/starlight/types';

/**
 * Shared sidebar definition used by Starlight docs pages and the homepage mobile nav.
 *
 * Top-level groups become Astro-docs-style sidebar tabs (see `TabbedSidebar.astro`):
 * Getting Started | Guides | Reference | Ecosystem
 */
export const sidebar: StarlightUserConfig['sidebar'] = [
  {
    label: 'Getting Started',
    items: [
      {
        label: 'Start here',
        collapsed: false,
        items: [
          { label: 'Introduction', slug: 'getting-started/introduction' },
          { label: 'Installation', slug: 'getting-started/installation' },
          { label: 'Usage', slug: 'getting-started/usage' },
          { label: 'Migration', slug: 'getting-started/migration' },
          { label: 'Wrapping up', slug: 'getting-started/wrapping-up' },
        ],
      },
    ],
  },
  {
    label: 'Guides',
    items: [
      {
        label: 'Core',
        collapsed: false,
        items: [
          { label: 'Schema', slug: 'guides/schema' },
          { label: 'Secrets', slug: 'guides/secrets' },
          { label: 'Environments', slug: 'guides/environments' },
          { label: 'Imports', slug: 'guides/import' },
          { label: 'Monorepos', slug: 'guides/monorepos' },
          { label: 'Plugins', slug: 'guides/plugins' },
          { label: 'Static vs dynamic', slug: 'guides/dynamic-config', badge: 'new' },
          { label: 'Code generation', slug: 'guides/code-generation', badge: 'new' },
        ],
      },
      {
        label: 'Encryption & delivery',
        collapsed: false,
        items: [
          { label: 'Local encryption', slug: 'guides/local-encryption' },
          { label: 'Encrypted deployments', slug: 'guides/encrypted-deployments' },
          { label: 'Caching', slug: 'guides/caching' },
          { label: 'OIDC Workload Identity', slug: 'guides/oidc' },
        ],
      },
      {
        label: 'AI & agents',
        collapsed: false,
        items: [
          {
            label: 'AI Tools',
            collapsed: true,
            items: [
              { label: 'Overview', slug: 'guides/ai-tools' },
              { label: 'Aider', slug: 'guides/ai-tools/aider' },
              { label: 'Antigravity CLI', slug: 'guides/ai-tools/antigravity' },
              { label: 'Claude Code', slug: 'guides/ai-tools/claude' },
              { label: 'Codex', slug: 'guides/ai-tools/codex' },
              { label: 'Crush', slug: 'guides/ai-tools/crush' },
              { label: 'Goose', slug: 'guides/ai-tools/goose' },
              { label: 'Kimi', slug: 'guides/ai-tools/kimi' },
              { label: 'Opencode', slug: 'guides/ai-tools/opencode' },
            ],
          },
          {
            label: 'MCP',
            collapsed: true,
            items: [
              { label: 'Overview', slug: 'guides/mcp' },
              { label: 'Local servers', slug: 'guides/mcp/local' },
              { label: 'Remote servers', slug: 'guides/mcp/remote' },
              { label: 'Docs MCP', slug: 'guides/mcp/docs-mcp' },
            ],
          },
          {
            label: 'Credential proxy',
            collapsed: true,
            badge: 'new',
            items: [
              { label: 'Overview', slug: 'guides/proxy' },
              { label: 'Routing rules', slug: 'guides/proxy/rules' },
              { label: 'Running modes', slug: 'guides/proxy/running' },
              { label: 'Sandboxing', slug: 'guides/proxy/sandboxing' },
            ],
          },
        ],
      },
      {
        label: 'Ops & migration',
        collapsed: false,
        items: [
          { label: 'Migrate from dotenv', slug: 'guides/migrate-from-dotenv' },
          { label: 'Shell completion', slug: 'guides/shell-completion' },
          { label: 'Telemetry', slug: 'guides/telemetry' },
        ],
      },
    ],
  },
  {
    label: 'Reference',
    items: [
      {
        label: 'CLI',
        collapsed: false,
        items: [
          { label: 'Overview', slug: 'reference/cli-commands' },
          { label: 'Load and run', slug: 'reference/cli/load-and-run' },
          { label: 'Project commands', slug: 'reference/cli/project' },
          { label: 'Encryption', slug: 'reference/cli/encryption' },
          { label: 'Cache and codegen', slug: 'reference/cli/cache-and-codegen' },
          { label: 'Proxy', slug: 'reference/cli/proxy' },
        ],
      },
      {
        label: 'Schema language',
        collapsed: false,
        items: [
          { label: 'Root decorators', slug: 'reference/root-decorators' },
          { label: 'Item decorators', slug: 'reference/item-decorators' },
          { label: '> @type data types', slug: 'reference/data-types' },
          { label: 'Resolver functions', slug: 'reference/functions' },
          { label: 'Builtin variables', slug: 'reference/builtin-variables' },
          { label: 'Reserved variables', slug: 'reference/reserved-variables' },
        ],
      },
      {
        label: '@env-spec',
        collapsed: false,
        items: [
          { label: 'Overview', slug: 'env-spec/overview' },
          { label: 'Reference', slug: 'env-spec/reference' },
          { label: 'VS Code extension', slug: 'env-spec/vs-code-ext' },
        ],
      },
    ],
  },
  {
    label: 'Ecosystem',
    items: [
      {
        label: 'Integrations',
        collapsed: false,
        items: [
          { label: 'Overview', slug: 'integrations/overview' },
          {
            label: 'JS runtimes & frameworks',
            collapsed: true,
            items: [
              { label: 'JavaScript / Node.js', slug: 'integrations/javascript' },
              { label: 'Bun', slug: 'integrations/bun' },
              { label: 'Next.js', slug: 'integrations/nextjs' },
              { label: 'Nuxt', slug: 'integrations/nuxt' },
              { label: 'Vite-based', slug: 'integrations/vite' },
              { label: 'Astro', slug: 'integrations/astro' },
              { label: 'SvelteKit', slug: 'integrations/sveltekit' },
              { label: 'TanStack Start', slug: 'integrations/tanstack-start' },
              { label: 'Cloudflare Workers', slug: 'integrations/cloudflare' },
              { label: 'Expo / React Native', slug: 'integrations/expo' },
            ],
          },
          {
            label: 'Other languages',
            collapsed: true,
            items: [
              { label: 'Python', slug: 'integrations/python' },
              { label: 'Rust', slug: 'integrations/rust' },
              { label: 'Go', slug: 'integrations/go' },
              { label: 'PHP', slug: 'integrations/php' },
              { label: 'Java', slug: 'integrations/java' },
              { label: 'C#', slug: 'integrations/csharp' },
              { label: 'Other languages', slug: 'integrations/other-languages' },
            ],
          },
          {
            label: 'Platforms & tooling',
            collapsed: true,
            items: [
              { label: 'Docker', slug: 'integrations/docker' },
              { label: 'GitHub Actions', slug: 'integrations/github-action' },
              { label: 'mise', slug: 'integrations/mise' },
              { label: 'direnv', slug: 'integrations/direnv' },
            ],
          },
        ],
      },
      {
        label: 'Plugins',
        collapsed: false,
        items: [
          { label: 'Overview', slug: 'plugins/overview' },
          {
            label: 'Password managers',
            collapsed: true,
            items: [
              { label: '1Password', slug: 'plugins/1password' },
              { label: 'Bitwarden', slug: 'plugins/bitwarden' },
              { label: 'Dashlane', slug: 'plugins/dashlane' },
              { label: 'Keeper', slug: 'plugins/keeper' },
              { label: 'KeePass', slug: 'plugins/keepass' },
              { label: 'Pass', slug: 'plugins/pass' },
              { label: 'Passbolt', slug: 'plugins/passbolt' },
              { label: 'Proton Pass', slug: 'plugins/proton-pass' },
              { label: 'macOS Keychain', slug: 'plugins/macos-keychain' },
            ],
          },
          {
            label: 'Secrets platforms',
            collapsed: true,
            items: [
              { label: 'Doppler', slug: 'plugins/doppler' },
              { label: 'Infisical', slug: 'plugins/infisical' },
              { label: 'HashiCorp Vault', slug: 'plugins/hashicorp-vault' },
              { label: 'Akeyless', slug: 'plugins/akeyless' },
            ],
          },
          {
            label: 'Cloud secret stores',
            collapsed: true,
            items: [
              { label: 'AWS SSM/SM', slug: 'plugins/aws-secrets' },
              { label: 'Azure Key Vault', slug: 'plugins/azure-key-vault' },
              { label: 'GCP Secret Manager', slug: 'plugins/google-secret-manager' },
            ],
          },
          {
            label: 'Infrastructure',
            collapsed: true,
            items: [
              {
                label: 'Kubernetes',
                collapsed: true,
                items: [
                  { label: 'Overview', slug: 'plugins/kubernetes' },
                  { label: 'Setup', slug: 'plugins/kubernetes/setup' },
                  { label: 'Loading values', slug: 'plugins/kubernetes/loading' },
                  { label: 'Cluster setup', slug: 'plugins/kubernetes/cluster-setup' },
                  { label: 'Reference', slug: 'plugins/kubernetes/reference' },
                ],
              },
            ],
          },
        ],
      },
      {
        label: 'Sandboxes',
        collapsed: false,
        badge: 'new',
        items: [
          { label: 'Overview', slug: 'sandboxes/overview' },
          {
            label: 'Cloud sandboxes',
            collapsed: true,
            items: [
              { label: 'E2B', slug: 'sandboxes/e2b' },
              { label: 'Fly.io', slug: 'sandboxes/flyio' },
              { label: 'Modal', slug: 'sandboxes/modal' },
            ],
          },
          {
            label: 'Local tools',
            collapsed: true,
            items: [
              { label: 'Docker Sandboxes', slug: 'sandboxes/docker-sandboxes' },
              { label: 'Minimal', slug: 'sandboxes/minimal' },
              { label: 'smolvm', slug: 'sandboxes/smolvm' },
              { label: 'Fence', slug: 'sandboxes/fence' },
              { label: 'yolobox', slug: 'sandboxes/yolobox' },
              { label: 'Agent Safehouse', slug: 'sandboxes/agent-safehouse' },
              { label: 'bubblewrap', slug: 'sandboxes/bubblewrap' },
              { label: 'MXC (Windows)', slug: 'sandboxes/mxc' },
            ],
          },
        ],
      },
    ],
  },
];
