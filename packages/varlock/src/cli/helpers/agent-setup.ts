import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const AI_TOOLS = ['cursor', 'claude', 'codex', 'opencode', 'vscode'] as const;
export type AiTool = typeof AI_TOOLS[number];

export const DOCS_MCP_URL = 'https://docs.mcp.varlock.dev/mcp';
export const DOCS_MCP_NAME = 'varlock-docs-mcp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_TEMPLATE_RELATIVE_PATH = 'templates/varlock-skill/SKILL.md';

const SKILL_PATHS: Record<AiTool, string | undefined> = {
  cursor: '.cursor/skills/varlock/SKILL.md',
  claude: '.claude/skills/varlock/SKILL.md',
  codex: '.agents/skills/varlock/SKILL.md',
  opencode: '.opencode/skills/varlock/SKILL.md',
  vscode: undefined,
};

const PROJECT_MARKERS: Array<{ marker: string; tool: AiTool; isFile?: boolean }> = [
  { marker: '.cursor', tool: 'cursor' },
  { marker: '.claude', tool: 'claude' },
  { marker: '.agents', tool: 'codex' },
  { marker: '.opencode', tool: 'opencode' },
  { marker: 'opencode.json', tool: 'opencode', isFile: true },
  { marker: '.vscode', tool: 'vscode' },
];

let cachedBundledSkillContent: string | undefined;
let cachedBundledSkillVersion: number | undefined;

function resolvePackageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const pkgJsonPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as { name?: string };
        if (pkgJson.name === 'varlock') return dir;
      } catch {
        // continue walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return path.resolve(__dirname, '..', '..', '..');
}

function resolveSkillTemplatePath(): string | undefined {
  const candidates = [
    path.join(resolvePackageRoot(), SKILL_TEMPLATE_RELATIVE_PATH),
    path.join(path.dirname(process.execPath), SKILL_TEMPLATE_RELATIVE_PATH),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return undefined;
}

export function parseVarlockSkillVersion(content: string): number {
  const match = content.match(/^\s*varlock-skill-version:\s*(\d+)\s*$/m);
  if (!match) return 0;
  return Number.parseInt(match[1], 10);
}

export function getBundledVarlockSkillContent(): string {
  if (cachedBundledSkillContent) return cachedBundledSkillContent;

  const templatePath = resolveSkillTemplatePath();
  if (!templatePath) {
    throw new Error(`Varlock skill template not found (expected ${SKILL_TEMPLATE_RELATIVE_PATH})`);
  }

  cachedBundledSkillContent = fs.readFileSync(templatePath, 'utf8');
  return cachedBundledSkillContent;
}

export function getBundledVarlockSkillVersion(): number {
  if (cachedBundledSkillVersion !== undefined) return cachedBundledSkillVersion;
  cachedBundledSkillVersion = parseVarlockSkillVersion(getBundledVarlockSkillContent());
  return cachedBundledSkillVersion;
}

export const VARLOCK_SKILL_VERSION = getBundledVarlockSkillVersion();

export function parseAiTool(value: string | undefined): AiTool | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return AI_TOOLS.find((tool) => tool === normalized);
}

function detectAiToolFromEnv(env: NodeJS.ProcessEnv = process.env): AiTool | undefined {
  if (env.CURSOR_AGENT) return 'cursor';
  if (env.CLAUDE_CODE || env.CLAUDECODE) return 'claude';
  if (env.CODEX_HOME || env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || env.OPENAI_CODEX) return 'codex';
  if (env.OPENCODE || env.OPENCODE_CONFIG) return 'opencode';
  if (env.TERM_PROGRAM === 'vscode') return 'vscode';
  return undefined;
}

function findGitRootSync(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function detectAiToolFromProjectMarkers(cwd: string): AiTool | undefined {
  const gitRoot = findGitRootSync(cwd);
  let current = path.resolve(cwd);
  const boundary = gitRoot ?? path.parse(current).root;

  while (true) {
    for (const { marker, tool, isFile } of PROJECT_MARKERS) {
      const markerPath = path.join(current, marker);
      if (isFile ? fs.existsSync(markerPath) && fs.statSync(markerPath).isFile() : fs.existsSync(markerPath)) {
        return tool;
      }
    }
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

export function detectAiTool(opts?: {
  cwd?: string,
  aiToolOverride?: string,
  env?: NodeJS.ProcessEnv,
}): AiTool | undefined {
  const override = parseAiTool(opts?.aiToolOverride);
  if (override) return override;

  const fromEnv = detectAiToolFromEnv(opts?.env);
  if (fromEnv) return fromEnv;

  return detectAiToolFromProjectMarkers(opts?.cwd ?? process.cwd());
}

function readJsonFile(filePath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function writeJsonFile(filePath: string, data: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function mergeJsonConfig(
  filePath: string,
  updater: (existing: Record<string, unknown>) => { data: Record<string, unknown>, changed: boolean },
): boolean {
  const existing = readJsonFile(filePath) ?? {};
  const { data, changed } = updater(existing);
  if (!changed) return false;
  writeJsonFile(filePath, data);
  return true;
}

export type SkillInstallResult = {
  action: 'installed' | 'updated' | 'skipped',
  version: number,
  skippedReason?: string,
};

export function installVarlockSkill(opts: {
  aiTool: AiTool,
  cwd?: string,
}): SkillInstallResult {
  const skillRelativePath = SKILL_PATHS[opts.aiTool];
  const bundledVersion = getBundledVarlockSkillVersion();

  if (!skillRelativePath) {
    return {
      action: 'skipped',
      version: bundledVersion,
      skippedReason: `${opts.aiTool} does not support project skills via SKILL.md`,
    };
  }

  const skillPath = path.join(opts.cwd ?? process.cwd(), skillRelativePath);
  const bundledContent = getBundledVarlockSkillContent();
  const hadExisting = fs.existsSync(skillPath);

  if (hadExisting) {
    const existingContent = fs.readFileSync(skillPath, 'utf8');
    const existingVersion = parseVarlockSkillVersion(existingContent);
    if (existingVersion >= bundledVersion) {
      return {
        action: 'skipped',
        version: existingVersion,
        skippedReason: `skill already up to date (v${existingVersion})`,
      };
    }
  }

  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, bundledContent);

  return {
    action: hadExisting ? 'updated' : 'installed',
    version: bundledVersion,
  };
}

function docsMcpAlreadyConfiguredInJson(data: Record<string, unknown>, sectionKey: string): boolean {
  const section = data[sectionKey];
  if (!section || typeof section !== 'object') return false;
  return DOCS_MCP_NAME in (section as Record<string, unknown>);
}

export function installDocsMcpForCursor(cwd: string): boolean {
  const filePath = path.join(cwd, '.cursor/mcp.json');
  return mergeJsonConfig(filePath, (existing) => {
    if (docsMcpAlreadyConfiguredInJson(existing, 'mcpServers')) {
      return { data: existing, changed: false };
    }
    const mcpServers = {
      ...(existing.mcpServers as Record<string, unknown> | undefined),
      [DOCS_MCP_NAME]: {
        command: 'npx',
        args: ['mcp-remote', DOCS_MCP_URL],
      },
    };
    return {
      data: { ...existing, mcpServers },
      changed: true,
    };
  });
}

export function installDocsMcpForVscode(cwd: string): boolean {
  const filePath = path.join(cwd, '.vscode/mcp.json');
  return mergeJsonConfig(filePath, (existing) => {
    if (docsMcpAlreadyConfiguredInJson(existing, 'servers')) {
      return { data: existing, changed: false };
    }
    const servers = {
      ...(existing.servers as Record<string, unknown> | undefined),
      [DOCS_MCP_NAME]: {
        type: 'http',
        url: DOCS_MCP_URL,
      },
    };
    return {
      data: { ...existing, servers },
      changed: true,
    };
  });
}

export function installDocsMcpForOpencode(cwd: string): boolean {
  const filePath = path.join(cwd, 'opencode.json');
  return mergeJsonConfig(filePath, (existing) => {
    if (docsMcpAlreadyConfiguredInJson(existing, 'mcp')) {
      return { data: existing, changed: false };
    }
    const mcp = {
      ...(existing.mcp as Record<string, unknown> | undefined),
      [DOCS_MCP_NAME]: {
        type: 'remote',
        url: DOCS_MCP_URL,
        enabled: true,
      },
    };
    return {
      data: { ...existing, mcp },
      changed: true,
    };
  });
}

export function installDocsMcpViaCli(
  aiTool: 'claude' | 'codex',
  opts?: { cwd?: string, execFn?: typeof execSync },
): boolean {
  const exec = opts?.execFn ?? execSync;
  const cwd = opts?.cwd ?? process.cwd();

  if (aiTool === 'claude') {
    try {
      exec(
        `claude mcp add --scope project --transport http ${DOCS_MCP_NAME} ${DOCS_MCP_URL}`,
        { cwd, stdio: 'pipe' },
      );
      return true;
    } catch {
      try {
        exec(
          `claude mcp add --scope user --transport http ${DOCS_MCP_NAME} ${DOCS_MCP_URL}`,
          { cwd, stdio: 'pipe' },
        );
        return true;
      } catch {
        return false;
      }
    }
  }

  try {
    exec(`codex mcp add ${DOCS_MCP_NAME} --url ${DOCS_MCP_URL}`, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function installDocsMcp(opts: {
  aiTool: AiTool,
  cwd?: string,
  execFn?: typeof execSync,
}): { installed: boolean, skippedReason?: string } {
  const cwd = opts.cwd ?? process.cwd();

  switch (opts.aiTool) {
    case 'cursor': {
      const installed = installDocsMcpForCursor(cwd);
      return installed
        ? { installed: true }
        : { installed: false, skippedReason: 'Docs MCP already configured' };
    }
    case 'vscode': {
      const installed = installDocsMcpForVscode(cwd);
      return installed
        ? { installed: true }
        : { installed: false, skippedReason: 'Docs MCP already configured' };
    }
    case 'opencode': {
      const installed = installDocsMcpForOpencode(cwd);
      return installed
        ? { installed: true }
        : { installed: false, skippedReason: 'Docs MCP already configured' };
    }
    case 'claude':
    case 'codex': {
      const installed = installDocsMcpViaCli(opts.aiTool, { cwd, execFn: opts.execFn });
      return installed
        ? { installed: true }
        : { installed: false, skippedReason: 'Docs MCP install failed or already configured' };
    }
    default:
      return { installed: false, skippedReason: 'unsupported AI tool' };
  }
}

export type AgentSetupResult = {
  aiTool?: AiTool,
  skill?: SkillInstallResult,
  docsMcp?: { installed: boolean, skippedReason?: string },
};

export function runAgentSetup(opts: {
  cwd?: string,
  aiToolOverride?: string,
  installSkill?: boolean,
  installDocsMcp?: boolean,
  env?: NodeJS.ProcessEnv,
  execFn?: typeof execSync,
}): AgentSetupResult {
  const cwd = opts.cwd ?? process.cwd();
  const aiTool = detectAiTool({
    cwd,
    aiToolOverride: opts.aiToolOverride,
    env: opts.env,
  });

  if (!aiTool) {
    return {};
  }

  const result: AgentSetupResult = { aiTool };

  if (opts.installSkill !== false) {
    result.skill = installVarlockSkill({ aiTool, cwd });
  }

  if (opts.installDocsMcp) {
    result.docsMcp = installDocsMcp({ aiTool, cwd, execFn: opts.execFn });
  }

  return result;
}
