import {
  cpSync, writeFileSync, readFileSync, readdirSync,
  rmSync, existsSync, mkdirSync,
} from 'node:fs';
import {
  join, dirname, basename, resolve,
} from 'node:path';
import { runCommand } from './command-runner.js';
import { runDevServer as runDevServerProcess } from './dev-server.js';
import { packPackages, getPackedDeps } from './pack.js';
import type {
  TestFixtureConfig, TestScenario, DevServerScenario, DevServerResult,
  BuildResult, TemplateFileSource,
} from './types.js';

const FRAMEWORK_TESTS_DIR = resolve(import.meta.dirname, '..');

/** Insert text after JS directives ('use client', 'use server') at the top of a file */
export function insertAfterDirectives(content: string, text: string): string {
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

/** Get the exec prefix for running binaries from node_modules/.bin */
export function execPrefix(pm: string): string {
  if (pm === 'bun') return 'bunx';
  if (pm === 'yarn') return 'yarn exec';
  if (pm === 'npm') return 'npx';
  return `${pm} exec`;
}

/**
 * Imperative fixture environment (no Vitest dependency).
 * Used by framework tests and by the release benchmarking suite.
 */
export class FrameworkTestEnv {
  dir!: string;
  protected filesDir: string;
  protected label: string;
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

    // Pack required varlock packages (unless measuring published registry versions)
    const varlockPackageNames = Object.keys(this.config.dependencies)
      .filter((dep) => dep === 'varlock' || dep.startsWith('@varlock/'));
    const usePublished = this.config.usePublished === true;
    let packedDeps: Record<string, string> = {};
    if (!usePublished) {
      packPackages(varlockPackageNames);
      packedDeps = getPackedDeps(varlockPackageNames);
    }

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
        ...packedDeps, // override varlock deps with packed file: paths (skipped when usePublished)
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
          if (usePublished) {
            // Prefer the version declared in dependencies when present
            const declared = this.config.dependencies[packedName];
            overrides[key] = declared && declared !== 'will-be-replaced'
              ? `npm:${packedName}@${declared}`
              : `npm:${packedName}`;
          } else {
            const packedPath = packedDeps[packedName];
            if (packedPath) {
              overrides[key] = packedPath;
            }
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
  protected applyFiles(scenario: Pick<TestScenario, 'templateFiles' | 'files'>): void {
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
      const srcRef: Exclude<TemplateFileSource, string> = typeof source === 'string'
        ? { path: source }
        : source;
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
   * Apply template / inline files without running a command.
   * Useful for benchmarks that measure with their own timers.
   */
  prepareFiles(scenario: Pick<TestScenario, 'templateFiles' | 'files'>): void {
    this.applyFiles(scenario);
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
