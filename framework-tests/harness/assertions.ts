import { readFileSync, existsSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { TestScenario, BuildResult, OutputAssertion } from './types.js';

/**
 * Assert that the build result matches the scenario's expectations.
 */
export function assertBuildResult(result: BuildResult, scenario: TestScenario): void {
  const expectSuccess = scenario.expectSuccess ?? true;

  if (expectSuccess) {
    expect(result.success, [
      `Expected "${scenario.command}" to succeed but got exit code ${result.exitCode}`,
      result.stderr ? `\nSTDERR:\n${result.stderr.slice(0, 2000)}` : '',
      result.stdout ? `\nSTDOUT (last 1000 chars):\n${result.stdout.slice(-1000)}` : '',
    ].filter(Boolean).join('')).toBe(true);
  } else {
    expect(result.success, [
      `Expected "${scenario.command}" to fail but it succeeded (exit code 0)`,
      result.stdout ? `\nSTDOUT (last 1000 chars):\n${result.stdout.slice(-1000)}` : '',
    ].filter(Boolean).join('')).toBe(false);
  }

  // Check output assertions
  if (scenario.outputAssertions) {
    const output = `${result.stdout}\n${result.stderr}`;

    for (const assertion of scenario.outputAssertions) {
      for (const str of assertion.shouldContain ?? []) {
        expect(output, `Command output should contain "${str}"`).toContain(str);
      }
      for (const str of assertion.shouldNotContain ?? []) {
        expect(output, `Command output should NOT contain "${str}"`).not.toContain(str);
      }
    }
  }
}

/**
 * Assert a single output assertion against build stdout/stderr.
 */
export function assertOutput(
  result: BuildResult,
  assertion: { shouldContain?: Array<string>; shouldNotContain?: Array<string> },
): void {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const str of assertion.shouldContain ?? []) {
    expect(output, `Command output should contain "${str}"`).toContain(str);
  }
  for (const str of assertion.shouldNotContain ?? []) {
    expect(output, `Command output should NOT contain "${str}"`).not.toContain(str);
  }
}

/**
 * Resolve file paths from an OutputAssertion's fileGlob or filePath.
 */
function resolveFilePaths(projectDir: string, assertion: OutputAssertion): Array<string> {
  if (assertion.filePath) {
    const fullPath = join(projectDir, assertion.filePath);
    return existsSync(fullPath) ? [fullPath] : [];
  }

  if (assertion.fileGlob) {
    const matches = globSync(assertion.fileGlob, { cwd: projectDir });
    return matches.map((m) => join(projectDir, m));
  }

  return [];
}

/**
 * Assert file contents match the given output assertions.
 */
export function assertFiles(projectDir: string, assertions: Array<OutputAssertion>): void {
  for (const assertion of assertions) {
    const filePaths = resolveFilePaths(projectDir, assertion);

    if (filePaths.length === 0) {
      const pattern = assertion.fileGlob ?? assertion.filePath ?? '(none)';
      throw new Error(`No files found matching "${pattern}" in ${projectDir}`);
    }

    // Concatenate all matched file contents for assertion
    const combinedContent = filePaths
      .map((fp) => readFileSync(fp, 'utf-8'))
      .join('\n');

    for (const str of assertion.shouldContain ?? []) {
      expect(combinedContent, `Output files should contain "${str}"`).toContain(str);
    }

    for (const str of assertion.shouldNotContain ?? []) {
      expect(combinedContent, `Output files should NOT contain "${str}"`).not.toContain(str);
    }

    for (const pattern of assertion.shouldMatch ?? []) {
      expect(combinedContent, `Output files should match ${pattern}`).toMatch(pattern);
    }
  }
}
