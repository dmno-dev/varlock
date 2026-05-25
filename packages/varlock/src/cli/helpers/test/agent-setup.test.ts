import {
  describe, test, expect, beforeEach, afterEach, vi,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  detectAiTool,
  DOCS_MCP_NAME,
  getBundledVarlockSkillVersion,
  installDocsMcp,
  installDocsMcpForCursor,
  installDocsMcpForOpencode,
  installDocsMcpForVscode,
  installVarlockSkill,
  parseAiTool,
  parseVarlockSkillVersion,
  runAgentSetup,
  VARLOCK_SKILL_VERSION,
} from '../agent-setup';

describe('parseAiTool', () => {
  test('parses valid tool names case-insensitively', () => {
    expect(parseAiTool('Cursor')).toBe('cursor');
    expect(parseAiTool('CLAUDE')).toBe('claude');
  });

  test('returns undefined for invalid values', () => {
    expect(parseAiTool('windsurf')).toBeUndefined();
    expect(parseAiTool('')).toBeUndefined();
  });
});

describe('detectAiTool', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-agent-setup-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('prefers --ai-tool override over env and project markers', () => {
    fs.mkdirSync(path.join(tempDir, '.cursor'));
    expect(detectAiTool({
      cwd: tempDir,
      aiToolOverride: 'claude',
      env: { CURSOR_AGENT: '1' },
    })).toBe('claude');
  });

  test('detects from environment signals', () => {
    expect(detectAiTool({ cwd: tempDir, env: { CURSOR_AGENT: '1' } })).toBe('cursor');
    expect(detectAiTool({ cwd: tempDir, env: { CLAUDE_CODE: '1' } })).toBe('claude');
    expect(detectAiTool({ cwd: tempDir, env: { CODEX_HOME: '/tmp/codex' } })).toBe('codex');
    expect(detectAiTool({ cwd: tempDir, env: { OPENCODE: '1' } })).toBe('opencode');
    expect(detectAiTool({ cwd: tempDir, env: { TERM_PROGRAM: 'vscode' } })).toBe('vscode');
  });

  test('detects from project markers when env is empty', () => {
    fs.mkdirSync(path.join(tempDir, '.cursor'));
    expect(detectAiTool({ cwd: tempDir, env: {} })).toBe('cursor');
  });

  test('walks up to git root for project markers', () => {
    fs.mkdirSync(path.join(tempDir, '.git'));
    fs.mkdirSync(path.join(tempDir, '.claude'));
    const nestedDir = path.join(tempDir, 'packages', 'app');
    fs.mkdirSync(nestedDir, { recursive: true });

    expect(detectAiTool({ cwd: nestedDir, env: {} })).toBe('claude');
  });

  test('returns undefined when nothing matches', () => {
    expect(detectAiTool({ cwd: tempDir, env: {} })).toBeUndefined();
  });
});

describe('parseVarlockSkillVersion', () => {
  test('reads version from metadata frontmatter', () => {
    expect(parseVarlockSkillVersion(`---
name: varlock
metadata:
  varlock-skill-version: 3
---
`)).toBe(3);
  });

  test('returns 0 when version is missing', () => {
    expect(parseVarlockSkillVersion(`---
name: varlock
---
`)).toBe(0);
  });
});

describe('installVarlockSkill', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-agent-setup-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('installs bundled skill for cursor', () => {
    const result = installVarlockSkill({ aiTool: 'cursor', cwd: tempDir });
    expect(result.action).toBe('installed');
    expect(result.version).toBe(VARLOCK_SKILL_VERSION);

    const skillPath = path.join(tempDir, '.cursor/skills/varlock/SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.readFileSync(skillPath, 'utf8')).toContain('name: varlock');
    expect(fs.readFileSync(skillPath, 'utf8')).toContain('Security rules');
  });

  test('does not overwrite when installed version matches bundled version', () => {
    const skillPath = path.join(tempDir, '.cursor/skills/varlock/SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, `---
name: varlock
metadata:
  varlock-skill-version: ${VARLOCK_SKILL_VERSION}
---
custom content`);

    const result = installVarlockSkill({ aiTool: 'cursor', cwd: tempDir });
    expect(result.action).toBe('skipped');
    expect(result.skippedReason).toContain('already up to date');
    expect(fs.readFileSync(skillPath, 'utf8')).toContain('custom content');
  });

  test('updates when installed version is older than bundled version', () => {
    const skillPath = path.join(tempDir, '.cursor/skills/varlock/SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, `---
name: varlock
description: old placeholder
---

`);

    const result = installVarlockSkill({ aiTool: 'cursor', cwd: tempDir });
    expect(result.action).toBe('updated');
    expect(result.version).toBe(getBundledVarlockSkillVersion());
    expect(fs.readFileSync(skillPath, 'utf8')).toContain('Security rules');
    expect(fs.readFileSync(skillPath, 'utf8')).not.toContain('old placeholder');
  });

  test('skips vscode because it has no standard skill path', () => {
    const result = installVarlockSkill({ aiTool: 'vscode', cwd: tempDir });
    expect(result.action).toBe('skipped');
    expect(result.skippedReason).toContain('does not support project skills');
  });
});

describe('Docs MCP JSON installs', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-agent-setup-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('merges cursor MCP config and preserves existing entries', () => {
    const filePath = path.join(tempDir, '.cursor/mcp.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      mcpServers: {
        existing: { command: 'node', args: ['server.js'] },
      },
    }));

    expect(installDocsMcpForCursor(tempDir)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(parsed.mcpServers.existing).toBeDefined();
    expect(parsed.mcpServers[DOCS_MCP_NAME]).toEqual({
      command: 'npx',
      args: ['mcp-remote', 'https://docs.mcp.varlock.dev/mcp'],
    });
  });

  test('skips cursor MCP install when already configured', () => {
    const filePath = path.join(tempDir, '.cursor/mcp.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      mcpServers: {
        [DOCS_MCP_NAME]: { command: 'npx', args: ['mcp-remote', 'https://docs.mcp.varlock.dev/mcp'] },
      },
    }));

    expect(installDocsMcpForCursor(tempDir)).toBe(false);
  });

  test('merges vscode MCP config', () => {
    expect(installDocsMcpForVscode(tempDir)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(path.join(tempDir, '.vscode/mcp.json'), 'utf8'));
    expect(parsed.servers[DOCS_MCP_NAME]).toEqual({
      type: 'http',
      url: 'https://docs.mcp.varlock.dev/mcp',
    });
  });

  test('merges opencode MCP config', () => {
    expect(installDocsMcpForOpencode(tempDir)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(path.join(tempDir, 'opencode.json'), 'utf8'));
    expect(parsed.mcp[DOCS_MCP_NAME]).toEqual({
      type: 'remote',
      url: 'https://docs.mcp.varlock.dev/mcp',
      enabled: true,
    });
  });
});

describe('installDocsMcp via CLI', () => {
  test('calls claude mcp add with project scope first', () => {
    const execFn = vi.fn();
    installDocsMcp({
      aiTool: 'claude',
      cwd: '/tmp/project',
      execFn,
    });

    expect(execFn).toHaveBeenCalledWith(
      'claude mcp add --scope project --transport http varlock-docs-mcp https://docs.mcp.varlock.dev/mcp',
      { cwd: '/tmp/project', stdio: 'pipe' },
    );
  });

  test('falls back to claude user scope when project scope fails', () => {
    const execFn = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('project scope failed');
      });

    installDocsMcp({
      aiTool: 'claude',
      cwd: '/tmp/project',
      execFn,
    });

    expect(execFn).toHaveBeenCalledTimes(2);
    expect(execFn.mock.calls[1]?.[0]).toContain('--scope user');
  });
});

describe('runAgentSetup', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-agent-setup-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('returns empty result when tool cannot be detected', () => {
    expect(runAgentSetup({ cwd: tempDir, env: {} })).toEqual({});
  });

  test('installs skill and docs MCP when requested', () => {
    const result = runAgentSetup({
      cwd: tempDir,
      aiToolOverride: 'cursor',
      installSkill: true,
      installDocsMcp: true,
    });

    expect(result.aiTool).toBe('cursor');
    expect(result.skill?.action).toBe('installed');
    expect(result.docsMcp?.installed).toBe(true);
  });

  test('can install docs MCP without skill', () => {
    const result = runAgentSetup({
      cwd: tempDir,
      aiToolOverride: 'cursor',
      installSkill: false,
      installDocsMcp: true,
    });

    expect(result.skill).toBeUndefined();
    expect(result.docsMcp?.installed).toBe(true);
  });
});
