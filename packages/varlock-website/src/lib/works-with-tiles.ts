/**
 * Homepage “Works with” integration tiles — single source for WorksWithLogoList and Prompt Builder.
 *
 * Categories: AI → languages → frameworks → secrets (plugins) → deployments.
 * Plugin and integration entries follow the docs sidebar.
 */
export type WorksWithTileCategory = 'languages' | 'ai' | 'frameworks' | 'secrets' | 'deployments';

export interface WorksWithTile {
  id: string;
  title: string;
  icon?: string;
  href?: string;
  category: WorksWithTileCategory;
}

/** Order for homepage grid and grouped UX */
export const CATEGORY_DISPLAY_ORDER: Array<WorksWithTileCategory> = [
  'ai',
  'languages',
  'frameworks',
  'secrets',
  'deployments',
];

export const WORKS_WITH_TILES: Array<WorksWithTile> = [
  // ─── AI tools ───
  {
    id: 'claude-code',
    title: 'Claude Code',
    icon: 'simple-icons:anthropic',
    href: '/guides/ai-tools/',
    category: 'ai',
  },
  {
    id: 'cursor',
    title: 'Cursor',
    icon: 'simple-icons:cursor',
    href: '/guides/ai-tools/',
    category: 'ai',
  },
  {
    id: 'copilot',
    title: 'CoPilot',
    icon: 'simple-icons:githubcopilot',
    href: '/guides/ai-tools/',
    category: 'ai',
  },
  {
    id: 'antigravity-cli',
    title: 'Antigravity CLI',
    icon: 'simple-icons:googlegemini',
    href: '/guides/ai-tools/',
    category: 'ai',
  },
  {
    id: 'opencode',
    title: 'Opencode',
    icon: 'opencode-logo',
    href: '/guides/ai-tools/',
    category: 'ai',
  },

  // ─── Languages (runtimes + TypeScript + other languages guide) ───
  {
    id: 'nodejs',
    title: 'JS/Node.js',
    icon: 'simple-icons:nodedotjs',
    href: '/integrations/javascript/',
    category: 'languages',
  },
  {
    id: 'typescript',
    title: 'TypeScript',
    icon: 'simple-icons:typescript',
    href: '/integrations/javascript/',
    category: 'languages',
  },
  {
    id: 'bun',
    title: 'Bun',
    icon: 'simple-icons:bun',
    href: '/integrations/bun/',
    category: 'languages',
  },
  {
    id: 'python',
    title: 'Python',
    icon: 'simple-icons:python',
    href: '/integrations/python/',
    category: 'languages',
  },
  {
    id: 'ruby',
    title: 'Ruby',
    icon: 'simple-icons:ruby',
    href: '/integrations/other-languages/',
    category: 'languages',
  },
  {
    id: 'go',
    title: 'Go',
    icon: 'simple-icons:go',
    href: '/integrations/go/',
    category: 'languages',
  },
  {
    id: 'php',
    title: 'PHP',
    icon: 'simple-icons:php',
    href: '/integrations/php/',
    category: 'languages',
  },
  {
    id: 'other-languages',
    title: 'Other languages',
    icon: 'mdi:earth',
    href: '/integrations/other-languages/',
    category: 'languages',
  },

  // ─── Frameworks ───
  {
    id: 'nextjs',
    title: 'Next.js',
    icon: 'simple-icons:nextdotjs',
    href: '/integrations/nextjs/',
    category: 'frameworks',
  },
  {
    id: 'vite',
    title: 'Vite',
    icon: 'simple-icons:vite',
    href: '/integrations/vite/',
    category: 'frameworks',
  },
  {
    id: 'astro',
    title: 'Astro',
    icon: 'simple-icons:astro',
    href: '/integrations/astro/',
    category: 'frameworks',
  },
  {
    id: 'sveltekit',
    title: 'SvelteKit',
    icon: 'simple-icons:svelte',
    href: '/integrations/sveltekit/',
    category: 'frameworks',
  },
  {
    id: 'tanstack-start',
    title: 'TanStack Start',
    icon: 'simple-icons:tanstack',
    href: '/integrations/tanstack-start/',
    category: 'frameworks',
  },
  {
    id: 'expo',
    title: 'Expo & React Native CLI',
    icon: 'simple-icons:expo',
    href: '/integrations/expo/',
    category: 'frameworks',
  },
  {
    id: 'qwik',
    title: 'Qwik',
    icon: 'simple-icons:qwik',
    href: '/integrations/vite/#frameworks',
    category: 'frameworks',
  },
  {
    id: 'react-router',
    title: 'React Router',
    icon: 'simple-icons:reactrouter',
    href: '/integrations/vite/#frameworks',
    category: 'frameworks',
  },

  // ─── Secrets / vaults (plugins) ───
  {
    id: '1password',
    title: '1Password',
    icon: 'simple-icons:1password',
    href: '/plugins/1password/',
    category: 'secrets',
  },
  {
    id: 'akeyless',
    title: 'Akeyless',
    icon: 'akeyless-logo',
    href: '/plugins/akeyless/',
    category: 'secrets',
  },
  {
    id: 'aws-secrets',
    title: 'AWS SSM/SM',
    icon: 'simple-icons:amazonaws',
    href: '/plugins/aws-secrets/',
    category: 'secrets',
  },
  {
    id: 'azure-key-vault',
    title: 'Azure Key Vault',
    icon: 'simple-icons:microsoftazure',
    href: '/plugins/azure-key-vault/',
    category: 'secrets',
  },
  {
    id: 'bitwarden',
    title: 'Bitwarden',
    icon: 'simple-icons:bitwarden',
    href: '/plugins/bitwarden/',
    category: 'secrets',
  },
  {
    id: 'dashlane',
    title: 'Dashlane',
    icon: 'simple-icons:dashlane',
    href: '/plugins/dashlane/',
    category: 'secrets',
  },
  {
    id: 'doppler',
    title: 'Doppler',
    icon: 'doppler-logo',
    href: '/plugins/doppler/',
    category: 'secrets',
  },
  {
    id: 'google-secret-manager',
    title: 'GCP Secret Manager',
    icon: 'simple-icons:googlecloud',
    href: '/plugins/google-secret-manager/',
    category: 'secrets',
  },
  {
    id: 'hashicorp-vault',
    title: 'HashiCorp Vault',
    icon: 'simple-icons:hashicorp',
    href: '/plugins/hashicorp-vault/',
    category: 'secrets',
  },
  {
    id: 'infisical',
    title: 'Infisical',
    icon: 'mdi:infinity',
    href: '/plugins/infisical/',
    category: 'secrets',
  },
  {
    id: 'keepass',
    title: 'KeePass',
    icon: 'simple-icons:keepassxc',
    href: '/plugins/keepass/',
    category: 'secrets',
  },
  {
    id: 'keeper',
    title: 'Keeper',
    icon: 'simple-icons:keeper',
    href: '/plugins/keeper/',
    category: 'secrets',
  },
  {
    id: 'macos-keychain',
    title: 'macOS Keychain',
    icon: 'simple-icons:apple',
    href: '/plugins/macos-keychain/',
    category: 'secrets',
  },
  {
    id: 'pass',
    title: 'Pass',
    icon: 'tabler:password',
    href: '/plugins/pass/',
    category: 'secrets',
  },
  {
    id: 'passbolt',
    title: 'Passbolt',
    icon: 'simple-icons:passbolt',
    href: '/plugins/passbolt/',
    category: 'secrets',
  },
  {
    id: 'proton-pass',
    title: 'Proton Pass',
    icon: 'simple-icons:proton',
    href: '/plugins/proton-pass/',
    category: 'secrets',
  },

  // ─── Deployments & environments ───
  {
    id: 'cloudflare-workers',
    title: 'Cloudflare Workers',
    icon: 'simple-icons:cloudflare',
    href: '/integrations/cloudflare/',
    category: 'deployments',
  },
  {
    id: 'docker',
    title: 'Docker',
    icon: 'simple-icons:docker',
    href: '/guides/docker/',
    category: 'deployments',
  },
  {
    id: 'github-actions',
    title: 'GitHub Actions',
    icon: 'simple-icons:githubactions',
    href: '/integrations/github-action/',
    category: 'deployments',
  },
  {
    id: 'gitlab-ci',
    title: 'GitLab CI',
    icon: 'simple-icons:gitlab',
    href: '/guides/oidc/#gitlab-ci',
    category: 'deployments',
  },
  {
    id: 'vercel',
    title: 'Vercel',
    icon: 'simple-icons:vercel',
    href: '/guides/oidc/#vercel',
    category: 'deployments',
  },
  {
    id: 'netlify',
    title: 'Netlify',
    icon: 'simple-icons:netlify',
    href: '/reference/builtin-variables/#supported-platforms',
    category: 'deployments',
  },
  {
    id: 'fly-io',
    title: 'Fly.io',
    icon: 'simple-icons:flydotio',
    href: '/guides/oidc/#flyio',
    category: 'deployments',
  },
  {
    id: 'gcp-cloud-run',
    title: 'GCP Cloud Run',
    icon: 'simple-icons:googlecloud',
    href: '/guides/oidc/#gcp-cloud-run',
    category: 'deployments',
  },
  {
    id: 'direnv',
    title: 'direnv',
    icon: 'mdi:folder-home-outline',
    href: '/integrations/direnv/',
    category: 'deployments',
  },
];

const byId = new Map(WORKS_WITH_TILES.map((t) => [t.id, t]));

export function getWorksWithTileById(id: string): WorksWithTile | undefined {
  return byId.get(id);
}

/** Sorted for homepage `WorksWithLogoList`: AI → languages → frameworks → secrets → deployments */
export function worksWithTilesForDisplay(): Array<WorksWithTile> {
  return [...WORKS_WITH_TILES].sort((a, b) => {
    const oa = CATEGORY_DISPLAY_ORDER.indexOf(a.category);
    const ob = CATEGORY_DISPLAY_ORDER.indexOf(b.category);
    if (oa !== ob) return oa - ob;
    return a.title.localeCompare(b.title);
  });
}

export function languageTiles(): Array<WorksWithTile> {
  return WORKS_WITH_TILES.filter((t) => t.category === 'languages');
}

/** Picked tiles (URL `pick=`) — everything except languages */
export function stackTiles(): Array<WorksWithTile> {
  return WORKS_WITH_TILES.filter((t) => t.category !== 'languages');
}

export function stackTilesByCategory(): Record<
  Exclude<WorksWithTileCategory, 'languages'>,
  Array<WorksWithTile>
> {
  const cats: Array<Exclude<WorksWithTileCategory, 'languages'>> = [
    'ai',
    'frameworks',
    'secrets',
    'deployments',
  ];
  const out = {
    ai: [] as Array<WorksWithTile>,
    frameworks: [] as Array<WorksWithTile>,
    secrets: [] as Array<WorksWithTile>,
    deployments: [] as Array<WorksWithTile>,
  };
  const stack = stackTiles();
  for (const c of cats) {
    out[c] = stack.filter((t) => t.category === c);
  }
  return out;
}

const PICK_CATEGORIES = new Set<WorksWithTileCategory>(['ai', 'frameworks', 'secrets', 'deployments']);

export function isPickableTileCategory(category: WorksWithTileCategory): boolean {
  return PICK_CATEGORIES.has(category);
}
