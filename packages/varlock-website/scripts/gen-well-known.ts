/**
 * Generates the machine-readable discovery files under `public/.well-known/`:
 *
 *  - `agent-skills/`: copies the canonical varlock usage skill from the repo root (`skills/`)
 *    so the HTTP discovery endpoint never drifts from the npm-bundled copy, and recomputes the
 *    sha256 digest for every skill from the file on disk before rewriting `index.json`.
 *  - `mcp.json` and `mcp/server-cards.json`: aliases of the authored `mcp/server-card.json`
 *    at the other paths agent-readiness scanners probe.
 *  - `ai-catalog.json`: an Agentic Resource Discovery (ARD) manifest listing the docs MCP
 *    server, llms.txt files, agent skills, and the CLI.
 *
 * Everything written here is a generated artifact (gitignored) and is rebuilt on every website
 * build. Authored sources are `mcp/server-card.json` and the two website-native skills
 * (`varlock-docs-search`, `varlock-agent-readiness`).
 */
import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, mkdirSync, copyFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';

const SITE = 'https://varlock.dev';
const WELL_KNOWN = resolve(import.meta.dir, '../public/.well-known');
const SKILLS_DIR = resolve(WELL_KNOWN, 'agent-skills');
const CANONICAL_SKILL = resolve(import.meta.dir, '../../../skills/varlock/SKILL.md');

function writeJson(relPath: string, data: unknown) {
  const target = resolve(WELL_KNOWN, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`[gen-well-known] wrote ${relPath}`);
}

// --- agent skills ---------------------------------------------------------------------------

/** Source of truth for the discovery index. Digests are computed, not authored. */
const SKILLS = [
  {
    name: 'varlock',
    description:
      'Securely manage environment variables and secrets with varlock: author .env.schema, '
      + 'use the varlock CLI, and wire up plugins and framework integrations.',
    copyFrom: CANONICAL_SKILL,
  },
  {
    name: 'varlock-docs-search',
    description: 'Search and reference varlock documentation via the hosted Docs MCP endpoint or llms.txt.',
  },
  {
    name: 'varlock-agent-readiness',
    description: 'Discover and verify the machine-readable discovery endpoints published by varlock.dev.',
  },
];

const skillsIndex = {
  $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
  skills: SKILLS.map((skill) => {
    const skillPath = resolve(SKILLS_DIR, skill.name, 'SKILL.md');
    if (skill.copyFrom) {
      mkdirSync(dirname(skillPath), { recursive: true });
      copyFileSync(skill.copyFrom, skillPath);
    }
    const digest = createHash('sha256').update(readFileSync(skillPath)).digest('hex');
    return {
      name: skill.name,
      type: 'skill-md',
      description: skill.description,
      url: `${SITE}/.well-known/agent-skills/${skill.name}/SKILL.md`,
      digest: `sha256:${digest}`,
    };
  }),
};
writeJson('agent-skills/index.json', skillsIndex);

// --- MCP server card aliases ---------------------------------------------------------------

const serverCard = JSON.parse(readFileSync(resolve(WELL_KNOWN, 'mcp/server-card.json'), 'utf8'));
writeJson('mcp.json', serverCard);
writeJson('mcp/server-cards.json', { servers: [serverCard] });

// --- ARD ai-catalog --------------------------------------------------------------------------

const aiCatalog = {
  specVersion: '1.0',
  host: {
    displayName: 'Varlock',
    identifier: 'varlock.dev',
    url: SITE,
  },
  entries: [
    {
      identifier: 'urn:ai:varlock.dev:mcp:docs',
      displayName: 'Varlock docs MCP server',
      description: 'Search and read the varlock documentation over MCP (streamable HTTP at /mcp, SSE at /sse). No authentication required.',
      type: 'application/mcp-server+json',
      url: `${SITE}/.well-known/mcp/server-card.json`,
      endpoint: 'https://docs.mcp.varlock.dev/mcp',
      representativeQueries: [
        'How do I mark a variable as sensitive in .env.schema?',
        'How do I run a command with varlock run?',
        'How do I load secrets from 1Password with varlock?',
        'How do I set up varlock with Next.js?',
      ],
    },
    {
      identifier: 'urn:ai:varlock.dev:docs:llms-txt',
      displayName: 'Varlock documentation index (llms.txt)',
      description: 'Entry point for agents: what varlock is, when to use it, install commands, and links to topic-specific documentation bundles.',
      type: 'text/markdown',
      url: `${SITE}/llms.txt`,
      representativeQueries: [
        'What is varlock and when should I use it?',
        'How do I install the varlock CLI?',
      ],
    },
    {
      identifier: 'urn:ai:varlock.dev:docs:llms-full',
      displayName: 'Varlock full documentation (llms-full.txt)',
      description: 'Every varlock docs page concatenated into one markdown file.',
      type: 'text/markdown',
      url: `${SITE}/llms-full.txt`,
      representativeQueries: [
        'Reference for varlock .env.schema decorators',
        'Which secret providers does varlock support?',
      ],
    },
    {
      identifier: 'urn:ai:varlock.dev:skills:index',
      displayName: 'Varlock agent skills',
      description: 'Agent Skills discovery index with SKILL.md files for using varlock, searching its docs, and verifying its discovery endpoints.',
      type: 'application/json',
      url: `${SITE}/.well-known/agent-skills/index.json`,
      representativeQueries: [
        'Install the varlock skill for my coding agent',
        'How should an agent edit .env.schema safely?',
      ],
    },
    {
      identifier: 'urn:ai:varlock.dev:cli:varlock',
      displayName: 'varlock CLI',
      description: 'Command line tool for loading, validating, encrypting, and scanning .env files. Install with npx varlock init, brew install dmno-dev/tap/varlock, or the install.sh script.',
      type: 'text/html',
      url: `${SITE}/getting-started/installation/`,
      representativeQueries: [
        'Install varlock',
        'Validate my .env file from the command line',
        'Scan my repo for leaked secrets',
      ],
    },
  ],
};
writeJson('ai-catalog.json', aiCatalog);
