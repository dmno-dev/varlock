/**
 * Generates the public `.well-known/agent-skills/` discovery tree:
 *
 *  - Copies the canonical varlock usage skill from the repo root (`skills/`)
 *    so the HTTP discovery endpoint never drifts from the npm-bundled copy.
 *  - Reads each skill's `name` and `description` from its SKILL.md frontmatter,
 *    recomputes the sha256 digest from the file on disk, and rewrites
 *    `index.json`. Digests and descriptions were previously hand-maintained
 *    here and would silently rot whenever a SKILL.md was edited.
 *
 * The copied `varlock/` skill and `index.json` are generated artifacts
 * (gitignored) and are rebuilt on every website build. The two website-native
 * skills (`varlock-docs-search`, `varlock-agent-readiness`) are authored
 * directly under `public/`; only their index entries are (re)generated here.
 */
import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, mkdirSync, copyFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';

const WELL_KNOWN = resolve(import.meta.dir, '../public/.well-known/agent-skills');
const CANONICAL_SKILL = resolve(import.meta.dir, '../../../skills/varlock/SKILL.md');

/** Skills in the discovery index. Metadata comes from each file's frontmatter. */
const SKILLS = [
  { name: 'varlock', copyFrom: CANONICAL_SKILL },
  { name: 'varlock-docs-search' },
  { name: 'varlock-agent-readiness' },
];

function readFrontmatter(skillPath: string, expectedName: string) {
  const raw = readFileSync(skillPath, 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`[gen-agent-skills] ${skillPath} has no frontmatter block`);
  const data = Bun.YAML.parse(match[1]) as Record<string, unknown>;
  const { name, description } = data;
  if (name !== expectedName) {
    throw new Error(`[gen-agent-skills] ${skillPath}: frontmatter name "${String(name)}" does not match directory "${expectedName}"`);
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`[gen-agent-skills] ${skillPath}: frontmatter is missing a description`);
  }
  return { name, description: description.replace(/\s*\n\s*/g, ' ').trim(), raw };
}

const index = {
  $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
  skills: SKILLS.map((skill) => {
    const skillPath = resolve(WELL_KNOWN, skill.name, 'SKILL.md');
    if (skill.copyFrom) {
      mkdirSync(dirname(skillPath), { recursive: true });
      copyFileSync(skill.copyFrom, skillPath);
    }
    const { description, raw } = readFrontmatter(skillPath, skill.name);
    const digest = createHash('sha256').update(raw).digest('hex');
    return {
      name: skill.name,
      type: 'skill-md',
      description,
      url: `https://varlock.dev/.well-known/agent-skills/${skill.name}/SKILL.md`,
      digest: `sha256:${digest}`,
    };
  }),
};

writeFileSync(resolve(WELL_KNOWN, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`[gen-agent-skills] wrote index.json with ${index.skills.length} skills`);
