/**
 * Generates the public `.well-known/agent-skills/` discovery tree:
 *
 *  - Copies the canonical varlock usage skill from the repo root (`skills/`)
 *    so the HTTP discovery endpoint never drifts from the npm-bundled copy.
 *  - Recomputes the sha256 digest for every skill from the file on disk and
 *    rewrites `index.json`. Digests were previously hand-maintained and would
 *    silently rot whenever a SKILL.md was edited.
 *
 * The copied `varlock/` skill and `index.json` are generated artifacts
 * (gitignored) and are rebuilt on every website build. The two website-native
 * skills (`varlock-docs-search`, `varlock-agent-readiness`) are authored
 * directly under `public/` — only their digests are (re)generated here.
 */
import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, mkdirSync, copyFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';

const WELL_KNOWN = resolve(import.meta.dir, '../public/.well-known/agent-skills');
const CANONICAL_SKILL = resolve(import.meta.dir, '../../../skills/varlock/SKILL.md');

/** Source of truth for the discovery index. Digests are computed, not authored. */
const SKILLS = [
  {
    name: 'varlock',
    description:
      'Securely manage environment variables and secrets with varlock — author .env.schema, '
      + 'use the varlock CLI, and wire up plugins and framework integrations.',
    copyFrom: CANONICAL_SKILL,
  },
  {
    name: 'varlock-docs-search',
    description: 'Search and reference varlock documentation via the hosted Docs MCP endpoint.',
  },
  {
    name: 'varlock-agent-readiness',
    description: 'Discover and verify varlock machine-readable discovery endpoints for agents.',
  },
];

const index = {
  $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
  skills: SKILLS.map((skill) => {
    const skillPath = resolve(WELL_KNOWN, skill.name, 'SKILL.md');
    if (skill.copyFrom) {
      mkdirSync(dirname(skillPath), { recursive: true });
      copyFileSync(skill.copyFrom, skillPath);
    }
    const digest = createHash('sha256').update(readFileSync(skillPath)).digest('hex');
    return {
      name: skill.name,
      type: 'skill-md',
      description: skill.description,
      url: `https://varlock.dev/.well-known/agent-skills/${skill.name}/SKILL.md`,
      digest: `sha256:${digest}`,
    };
  }),
};

writeFileSync(resolve(WELL_KNOWN, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`[gen-agent-skills] wrote index.json with ${index.skills.length} skills`);
