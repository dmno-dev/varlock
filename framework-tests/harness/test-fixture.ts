import {
  cpSync, writeFileSync, readFileSync, readdirSync,
  rmSync, existsSync, mkdirSync,
} from 'node:fs';
import {
  join, dirname, basename, resolve,
} from 'node:path';

const FRAMEWORK_TESTS_DIR = resolve(import.meta.dirname, '..');
import {
  describe, test, beforeAll, expect,
} from 'vitest';
import { runCommand } from './command-runner.js';
import { runDevServer as runDevServerProcess } from './dev-server.js';
import { packPackages, getPackedDeps } from './pack.js';
import {
  assertBuildResult, assertOutput, assertFiles,
} from './assertions.js';
import type {
  TestFixtureConfig, TestScenario, DevServerScenario, DevServerResult,
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

/** Insert text after JS directives ('use client', 'use server') at the top of a file */
function insertAfterDirectives(content: string, text: string): string {
  const lines = content.split('\n');
  let insertIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') {
      continue;
    }
    if (/^['"]use (client|server)['"];?\s*$/.test(trimmed)) {
      insertIdx = i + 1;
      continue;
    }
    break;
  }
  lines.splice(insertIdx, 0, text);
  return lines.join('\n');
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

/** Get the exec prefix for running binaries from node_modules/.bin */
function execPrefix(pm: string): string {
  if (pm === 'bun') return 'bunx';
  if (pm === 'yarn') return 'yarn exec';
  if (pm === 'npm') return 'npx';
  return `${pm} exec`;
}

export class FrameworkTestEnv {
  dir!: string;
  private filesDir: string;
  private label: string;
  /** Files written by the previous scenario, restored before the next one runs */
  private prevScenarioFiles = new Set<string>();

  constructor(public config: TestFixtureConfig) {
    this.filesDir = join(config.testDir, 'files');
    this.label = config.framework ?? basename(config.testDir);
  }

  /**
   * Create temp dir, copy base template, build package.json, install deps.
   */
  async setup(): Promise<void> {
    this.dir = join(FRAMEWORK_TESTS_DIR, '.test-projects', this.label);
    if (existsSync(this.dir)) {
      rmSync(this.dir, { recursive: true, force: true });
    }
    mkdirSync(this.dir, { recursive: true });
    console.log(`[${this.label}] Setting up fixture in ${this.dir}`);

    // Isolate from parent workspaces so the test project
    // is treated as its own independent root

    // Prevent bun from inheriting the repo root's bunfig.toml which has
    // minimumReleaseAge and a security scanner that can block/hang installs
    writeFileSync(join(this.dir, 'bunfig.toml'), [
      '[install]',
      'minimumReleaseAge = 0',
      '',
    ].join('\n'));

    // pnpm v11 defaults: block all build scripts, and error on packages missing time metadata.
    // Allow known native packages that need postinstall scripts.
    // minimumReleaseAge is 0 here (matching bunfig.toml) so framework tests can use
    // recently published versions (e.g. new Astro majors) without waiting 72h.
    writeFileSync(join(this.dir, 'pnpm-workspace.yaml'), [
      'minimumReleaseAge: 0',
      'onlyBuiltDependencies:',
      '  - esbuild',
      '  - sharp',
      '  - lightningcss',
      '  - workerd',
      '',
    ].join('\n'));
    writeFileSync(join(this.dir, '.npmrc'), 'ignore-workspace-root-check=true\n');

    // Copy _base/ skeleton into the project
    const baseDir = join(this.filesDir, '_base');
    if (existsSync(baseDir)) {
      cpSync(baseDir, this.dir, { recursive: true });
    }

    // Pack required varlock packages
    const varlockPackageNames = Object.keys(this.config.dependencies)
      .filter((dep) => dep === 'varlock' || dep.startsWith('@varlock/'));
    packPackages(varlockPackageNames);
    const packedDeps = getPackedDeps(varlockPackageNames);

    // Build package.json
    const templatePkgPath = join(this.dir, 'package.json');
    const templatePkg = existsSync(templatePkgPath)
      ? JSON.parse(readFileSync(templatePkgPath, 'utf-8'))
      : {};

    const pm = this.config.packageManager ?? 'pnpm';

    const pkg = {
      name: 'framework-test-project',
      version: '0.0.0',
      private: true,
      type: 'module',
      ...templatePkg,
      dependencies: {
        ...templatePkg.dependencies,
        ...this.config.dependencies,
        ...packedDeps, // override varlock deps with packed file: paths
      },
      ...(this.config.devDependencies ? {
        devDependencies: {
          ...templatePkg.devDependencies,
          ...this.config.devDependencies,
        },
      } : {}),
      ...(this.config.scripts ? {
        scripts: { ...templatePkg.scripts, ...this.config.scripts },
      } : {}),
    };

    // Apply overrides — pnpm nests them under `pnpm.overrides`
    if (this.config.overrides) {
      if (pm === 'pnpm') {
        pkg.pnpm = { ...templatePkg.pnpm, overrides: { ...templatePkg.pnpm?.overrides, ...this.config.overrides } };
      } else {
        pkg.overrides = { ...templatePkg.overrides, ...this.config.overrides };
      }
    }

    // Apply packageJsonMerge (deep merge one level)
    if (this.config.packageJsonMerge) {
      for (const [key, value] of Object.entries(this.config.packageJsonMerge)) {
        if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
          pkg[key] = { ...pkg[key], ...value };
        } else {
          pkg[key] = value;
        }
      }
    }

    // Replace <packed:pkg-name> placeholders in any overrides sections
    const overrideSections = [
      pkg.overrides, // npm/bun top-level overrides
      pkg.pnpm?.overrides, // pnpm overrides
    ];
    for (const overrides of overrideSections) {
      if (!overrides) continue;
      for (const [key, val] of Object.entries(overrides)) {
        if (typeof val === 'string' && val.startsWith('<packed:')) {
          const packedName = val.slice('<packed:'.length, -1);
          const packedPath = packedDeps[packedName];
          if (packedPath) {
            overrides[key] = packedPath;
          }
        }
      }
    }

    writeFileSync(templatePkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

    // Install dependencies
    const installCmd = pm === 'yarn' ? 'yarn install' : `${pm} install`;
    console.log(`[${this.label}] Installing dependencies with ${pm}...`);
    const installResult = await runCommand(this.dir, installCmd, {
      timeout: this.config.installTimeout ?? 120_000,
    });

    if (!installResult.success) {
      console.error(`[${this.label}] Install failed (exit code ${installResult.exitCode}):\n${installResult.stderr || installResult.stdout || '(no output)'}`);
      throw new Error(`Dependency installation failed for fixture "${this.label}"`);
    }
    console.log(`[${this.label}] Dependencies installed successfully`);
  }

  /**
   * Apply template files and inline files to the test project directory.
   * Files written by the previous scenario are first restored to their _base
   * version (or removed if not part of the skeleton), so scenarios stay
   * isolated — e.g. a config override or extra route from one scenario
   * doesn't silently carry over into the next.
   */
  private applyFiles(scenario: Pick<TestScenario, 'templateFiles' | 'files'>): void {
    for (const dest of this.prevScenarioFiles) {
      const basePath = join(this.filesDir, '_base', dest);
      const destPath = join(this.dir, dest);
      if (existsSync(basePath)) {
        cpSync(basePath, destPath);
      } else {
        rmSync(destPath, { force: true });
      }
    }
    this.prevScenarioFiles = new Set();

    // Copy template files: fixture defaults merged with scenario overrides
    const templateFiles = {
      ...this.config.templateFiles,
      ...scenario.templateFiles,
    };
    for (const [dest, source] of Object.entries(templateFiles)) {
      this.prevScenarioFiles.add(dest);
      const srcRef = typeof source === 'string' ? { path: source } : source;
      const srcPath = join(this.filesDir, srcRef.path);
      const destPath = join(this.dir, dest);
      mkdirSync(dirname(destPath), { recursive: true });
      cpSync(srcPath, destPath);

      // Apply transformations (replacements, prepend, append)
      if (typeof source !== 'string') {
        let content = readFileSync(destPath, 'utf-8');
        if (srcRef.replacements) {
          for (const [find, replace] of Object.entries(srcRef.replacements)) {
            content = content.replaceAll(find, replace);
          }
        }
        if (srcRef.prepend) {
          content = `${srcRef.prepend}\n${content}`;
        }
        if (srcRef.insertAfterDirectives) {
          content = insertAfterDirectives(content, srcRef.insertAfterDirectives);
        }
        if (srcRef.append) {
          content = `${content}\n${srcRef.append}`;
        }
        writeFileSync(destPath, content);
      }
    }

    // Write inline files
    if (scenario.files) {
      for (const file of scenario.files) {
        this.prevScenarioFiles.add(file.path);
        const destPath = join(this.dir, file.path);
        mkdirSync(dirname(destPath), { recursive: true });
        writeFileSync(destPath, file.content);
      }
    }
  }

  /**
   * Run a test scenario: write files, build, return result.
   */
  async runScenario(scenario: TestScenario): Promise<BuildResult> {
    // Clean previous build artifacts
    this.cleanBuildArtifacts();

    this.applyFiles(scenario);

    // Run command, auto-prefixed with package manager exec
    const pm = this.config.packageManager ?? 'pnpm';
    const buildCmd = `${execPrefix(pm)} ${scenario.command}`;

    return runCommand(this.dir, buildCmd, {
      env: scenario.env,
      timeout: scenario.timeout ?? 120_000,
      killAfterPattern: scenario.killAfterPattern,
    });
  }

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
   * Run a dev server scenario: write files, start server, make requests, return result.
   */
  async runDevServer(scenario: DevServerScenario): Promise<DevServerResult> {
    this.cleanBuildArtifacts();
    this.applyFiles(scenario);

    const pm = this.config.packageManager ?? 'pnpm';
    const command = `${execPrefix(pm)} ${scenario.command}`;

    return runDevServerProcess(this.dir, command, scenario);
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

  /**
   * Clean build artifacts between scenarios.
   */
  cleanBuildArtifacts(): void {
    // Clean .next but preserve the cache directory so turbopack/webpack
    // compilation cache speeds up subsequent builds within the same fixture
    const nextDir = join(this.dir, '.next');
    if (existsSync(nextDir)) {
      for (const entry of readdirSync(nextDir)) {
        if (entry === 'cache') continue;
        rmSync(join(nextDir, entry), { recursive: true, force: true });
      }
    }

    const artifactDirs = ['out', 'dist', '.turbo', '.wrangler'];
    for (const dir of artifactDirs) {
      const fullPath = join(this.dir, dir);
      if (existsSync(fullPath)) {
        rmSync(fullPath, { recursive: true, force: true });
      }
    }
  }

  /**
   * Remove the entire temp directory.
   */
  async teardown(): Promise<void> {
    if (this.dir && existsSync(this.dir)) {
      if (process.env.KEEP_TEST_DIRS) {
        console.log(`[${this.label}] Preserving test dir: ${this.dir}`);
      } else {
        // retry removal — on CI, child processes (e.g. wrangler) may still be
        // releasing file handles when teardown runs, causing ENOTEMPTY
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            rmSync(this.dir, { recursive: true, force: true });
            break;
          } catch (err) {
            if (attempt < 2) {
              await new Promise<void>((r) => {
                setTimeout(r, 500);
              });
            } else {
              console.warn(`[${this.label}] Failed to clean up ${this.dir}: ${(err as Error).message}`);
            }
          }
        }
        console.log(`[${this.label}] Cleaned up ${this.dir}`);
      }
    }
  }
}
