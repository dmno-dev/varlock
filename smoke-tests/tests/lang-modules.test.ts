import { describe, expect, test } from 'vitest';
import { execSync } from 'node:child_process';

import { varlockRun } from '../helpers/run-varlock';

/** Is a CLI tool available on PATH? Used to skip a language test when its toolchain isn't installed. */
function hasTool(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Each test regenerates the module, compiles/runs it, and injects the resolved env — all via
// `varlock run -- <cmd>` — proving the generated code is not just syntactically valid but
// actually loads the __VARLOCK_ENV blob and exposes correctly-typed values. Skips when the
// toolchain is missing so the suite stays green on machines without every language installed.
describe('generated language modules compile and run', () => {
  test.skipIf(!hasTool('python3'))('Python module loads under varlock run', () => {
    const result = varlockRun(['python3', 'main.py'], { cwd: 'smoke-test-lang-python' });
    expect(result.output).toContain('OK');
    expect(result.exitCode).toBe(0);
  });

  test.skipIf(!hasTool('go'))('Go module compiles and runs', () => {
    const result = varlockRun(['go', 'run', '.'], { cwd: 'smoke-test-lang-go' });
    expect(result.output).toContain('OK');
    expect(result.exitCode).toBe(0);
  }, 120_000);

  test.skipIf(!hasTool('cargo'))('Rust module compiles and runs', () => {
    const result = varlockRun(['cargo', 'run', '--quiet'], { cwd: 'smoke-test-lang-rust' });
    expect(result.output).toContain('OK');
    expect(result.exitCode).toBe(0);
  }, 300_000);

  test.skipIf(!hasTool('php'))('PHP module runs', () => {
    const result = varlockRun(['php', 'main.php'], { cwd: 'smoke-test-lang-php' });
    expect(result.output).toContain('OK');
    expect(result.exitCode).toBe(0);
  });
});
