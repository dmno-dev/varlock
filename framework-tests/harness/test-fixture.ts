import {
  describe, test, beforeAll, expect,
} from 'vitest';
import {
  assertBuildResult, assertOutput, assertFiles,
} from './assertions.js';
import {
  FrameworkTestEnv as BaseFrameworkTestEnv,
} from './fixture-env.js';
import type {
  TestScenario, DevServerScenario, DevServerResult,
  BuildResult, TemplateFileMap, TemplateFileSource,
} from './types.js';

/** Add `export const runtime = 'edge'` after directives to all .ts/.tsx template files */
function addEdgeRuntimeToTemplateFiles(templateFiles?: TemplateFileMap): TemplateFileMap | undefined {
  if (!templateFiles) return templateFiles;
  const result: TemplateFileMap = {};
  for (const [dest, source] of Object.entries(templateFiles)) {
    if (/\.tsx?$/.test(dest)) {
      const srcRef: Exclude<TemplateFileSource, string> = typeof source === 'string' ? { path: source } : { ...source };
      srcRef.insertAfterDirectives = [
        srcRef.insertAfterDirectives,
        "export const runtime = 'edge';",
      ].filter(Boolean).join('\n');
      result[dest] = srcRef;
    } else {
      result[dest] = source;
    }
  }
  return result;
}

/** Apply .only or .skip modifier to a vitest describe/test function based on flags */
function withSkipOrOnly<T extends { only: any; skip: any }>(
  fn: T,
  opts: { only?: boolean; skip?: boolean },
): T {
  if (opts.only) return fn.only;
  if (opts.skip) return fn.skip;
  return fn;
}

/**
 * Vitest-aware fixture env used by framework test suites.
 * Benchmarks should import the base class from `./fixture-env.js` instead,
 * so Vitest is not loaded outside a test runner.
 */
export class FrameworkTestEnv extends BaseFrameworkTestEnv {
  /**
   * Run a scenario and assert results in a single test.
   */
  async runTest(scenario: TestScenario): Promise<void> {
    const result = await this.runScenario(scenario);
    assertBuildResult(result, scenario);
    if (scenario.fileAssertions) {
      assertFiles(this.dir, scenario.fileAssertions);
    }
  }

  /**
   * Create a describe block that builds once and runs each assertion as a separate test.
   * Usage: nextEnv.describeScenario('basic page', { command, templateFiles, fileAssertions, outputAssertions })
   */
  describeScenario(name: string, scenario: TestScenario): void {
    if (scenario.alsoTestEdgeRuntime) {
      const { alsoTestEdgeRuntime: _, ...baseScenario } = scenario;
      this.describeScenario(`${name} (nodejs)`, baseScenario);
      this.describeScenario(`${name} (edge)`, {
        ...baseScenario,
        templateFiles: addEdgeRuntimeToTemplateFiles(baseScenario.templateFiles),
      });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const env = this;
    withSkipOrOnly(describe, scenario)(name, () => {
      const ctx: { result?: BuildResult } = {};
      beforeAll(async () => {
        ctx.result = await env.runScenario(scenario);
      // Add buffer over command timeout so the command can resolve before the hook times out
      }, (scenario.timeout ?? 120_000) + 5_000);

      // When expectSuccess is explicitly set, assert on the exit code.
      // When omitted (undefined), skip the assertion (useful for long-running
      // commands killed by killAfterPattern where exit code is meaningless).
      if (scenario.expectSuccess !== undefined) {
        const expectSuccess = scenario.expectSuccess;
        test(expectSuccess ? 'build succeeds' : 'build fails as expected', () => {
          assertBuildResult(ctx.result!, {
            command: scenario.command,
            expectSuccess,
          });
        });
      }

      for (const assertion of scenario.outputAssertions ?? []) {
        const testName = assertion.description ?? 'output assertions pass';
        withSkipOrOnly(test, assertion)(testName, () => {
          assertOutput(ctx.result!, assertion);
        });
      }

      for (const assertion of scenario.fileAssertions ?? []) {
        const testName = assertion.description
          ?? `file assertions (${assertion.fileGlob ?? assertion.filePath})`;
        withSkipOrOnly(test, assertion)(testName, () => {
          assertFiles(env.dir, [assertion]);
        });
      }
    });
  }

  /**
   * Create a describe block that starts a dev server once and runs each assertion as a separate test.
   */
  describeDevScenario(name: string, scenario: DevServerScenario): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const env = this;
    withSkipOrOnly(describe, scenario)(name, () => {
      const ctx: { result?: DevServerResult } = {};
      beforeAll(async () => {
        ctx.result = await env.runDevServer(scenario);
      }, scenario.timeout ?? 120_000);

      test('dev server starts successfully', () => {
        expect(ctx.result!.success, [
          'Dev server failed to start',
          ctx.result!.error ? `\nError: ${ctx.result!.error}` : '',
          ctx.result!.stderr ? `\nSTDERR:\n${ctx.result!.stderr.slice(0, 2000)}` : '',
        ].filter(Boolean).join('')).toBe(true);
      });

      for (let i = 0; i < scenario.requests.length; i++) {
        const req = scenario.requests[i];
        const testLabel = req.label ?? (req.fileEdits
          ? `GET ${req.path} returns expected response (after file edit)`
          : `GET ${req.path} returns expected response`);
        test(testLabel, () => {
          const resp = ctx.result!.responses[i];
          expect(resp, `No response for request ${i} (GET ${req.path})`).toBeDefined();
          // requests marked allowRequestFailure only assert status when explicitly set
          if (req.expectedStatus !== undefined || !req.allowRequestFailure) {
            const expectedStatus = req.expectedStatus ?? 200;
            expect(resp.status, `Expected status ${expectedStatus} for GET ${req.path}, got ${resp.status}`).toBe(expectedStatus);
          }
          for (const str of req.bodyAssertions?.shouldContain ?? []) {
            expect(resp.body, `Response body should contain "${str}"`).toContain(str);
          }
          for (const str of req.bodyAssertions?.shouldNotContain ?? []) {
            expect(resp.body, `Response body should NOT contain "${str}"`).not.toContain(str);
          }
          for (const [headerName, expected] of Object.entries(req.headerAssertions ?? {})) {
            const actual = resp.headers[headerName];
            if (expected instanceof RegExp) {
              expect(actual, `Header "${headerName}" should match ${expected}`).toMatch(expected);
            } else {
              expect(actual, `Header "${headerName}" should be "${expected}"`).toBe(expected);
            }
          }
        });
      }

      for (const assertion of scenario.outputAssertions ?? []) {
        const testName = assertion.description ?? 'output assertions pass';
        withSkipOrOnly(test, assertion)(testName, () => {
          assertOutput(ctx.result!, assertion);
        });
      }
    });
  }
}
