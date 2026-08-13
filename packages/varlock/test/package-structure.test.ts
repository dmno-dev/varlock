import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('package.json structure', () => {
  it('should have no dependencies - everything must be bundled', () => {
    const packageJsonPath = join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

    expect(packageJson.dependencies).toEqual({});
  });

  it('should only have first-party native binary packages as optionalDependencies', () => {
    const packageJsonPath = join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

    const optionalDeps = Object.keys(packageJson.optionalDependencies ?? {});
    expect(optionalDeps.length).toBeGreaterThan(0);
    for (const dep of optionalDeps) {
      expect(dep).toMatch(/^@varlock\/native-helper-/);
    }
  });
});
