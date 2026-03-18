export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** A file to write inline into the test project */
export interface ProjectFile {
  /** Path relative to project root, e.g. "app/page.tsx" */
  path: string;
  /** File content as a string */
  content: string;
}

/** Template file source: either a plain path or a path with find/replace transformations */
export type TemplateFileSource = string | {
  /** Source path within the files/ directory */
  path: string;
  /** Find/replace pairs applied after copying */
  replacements?: Record<string, string>;
  /** Content to prepend to the file */
  prepend?: string;
  /** Content to insert after JS directives ('use client', 'use server', etc.) */
  insertAfterDirectives?: string;
  /** Content to append to the file */
  append?: string;
};

/**
 * Map of destination path → template source.
 * Values can be a plain string (source path) or an object with path + replacements.
 * e.g. { '.env.schema': 'schemas/.env.schema', 'next.config.mjs': { path: '_base/next.config.mjs', replacements: { '// OUTPUT-MODE': "output: 'export'" } } }
 */
export type TemplateFileMap = Record<string, TemplateFileSource>;

/** Assertions to run against output files */
export interface OutputAssertion {
  /** Test name when used with describeScenario (default: auto-generated from glob/path) */
  description?: string;
  /** Skip this assertion */
  skip?: boolean;
  /** Run only this assertion */
  only?: boolean;
  /** Glob pattern for files to scan, relative to project root */
  fileGlob?: string;
  /** Specific file path to check, relative to project root */
  filePath?: string;
  /** Strings that MUST be present in file content */
  shouldContain?: Array<string>;
  /** Strings that MUST NOT be present in file content */
  shouldNotContain?: Array<string>;
  /** Regex patterns that MUST match file content */
  shouldMatch?: Array<RegExp>;
}

/**
 * A fixture defines the installed environment: framework version,
 * package manager, and base configuration. Installed ONCE, shared across scenarios.
 */
export interface TestFixtureConfig {
  /** Package manager to use (default: 'pnpm') */
  packageManager?: PackageManager;
  /** Absolute path to the test's directory (use import.meta.dirname). Template files are resolved from `files/` within this dir. */
  testDir: string;
  /** Optional label for logs and temp dir naming (default: basename of testDir) */
  framework?: string;
  /** Dependencies to install */
  dependencies: Record<string, string>;
  /** Dev dependencies to install */
  devDependencies?: Record<string, string>;
  /** Extra fields to merge into package.json (scripts, overrides, etc.) */
  packageJsonMerge?: Record<string, any>;
  /** Default template files applied to every scenario (scenarios can override individual keys) */
  templateFiles?: TemplateFileMap;
  /** Timeout for dependency installation in ms (default: 120_000) */
  installTimeout?: number;
}

/**
 * A scenario runs against an already-installed fixture.
 * Selects files from the template library and/or provides inline files,
 * runs a build, and asserts on the result.
 */
export interface TestScenario {
  /** Files to copy from the framework's files/ directory. Keys are dest paths, values are source paths. */
  templateFiles?: TemplateFileMap;
  /** Inline files to write (written after templateFiles, can override) */
  files?: Array<ProjectFile>;
  /** Extra env vars for the build command */
  env?: Record<string, string>;
  /** Command to run (auto-prefixed with `{pm} exec`, e.g. 'next build' → 'pnpm exec next build') */
  command: string;
  /** Whether the command should succeed (default: true) */
  expectSuccess?: boolean;
  /** Assertions on command stdout/stderr */
  outputAssertions?: Array<{
    /** Test name when used with describeScenario */
    description?: string;
    /** Skip this assertion */
    skip?: boolean;
    /** Run only this assertion */
    only?: boolean;
    shouldContain?: Array<string>;
    shouldNotContain?: Array<string>;
  }>;
  /** Assertions on output files after build */
  fileAssertions?: Array<OutputAssertion>;
  /** Timeout for this scenario in ms (default: 120_000) */
  timeout?: number;
  /** Also run the entire scenario with `export const runtime = 'edge'` inserted after directives in all .tsx/.ts template files */
  alsoTestEdgeRuntime?: boolean;
  /** Skip this entire scenario */
  skip?: boolean;
  /** Run only this scenario */
  only?: boolean;
}

/** Result of running a build command */
export interface BuildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
}
