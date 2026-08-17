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

  it('should declare exactly the native helper platform packages as optionalDependencies', () => {
    const packageJsonPath = join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

    // the complete set, pinned via workspace:* (resolved to exact versions at
    // pack time) - a missing platform, an unexpected extra, or a range pin
    // would all break the release contract
    expect(packageJson.optionalDependencies).toEqual({
      '@varlock/native-helper-darwin': 'workspace:*',
      '@varlock/native-helper-linux-arm64': 'workspace:*',
      '@varlock/native-helper-linux-x64': 'workspace:*',
      '@varlock/native-helper-win32-x64': 'workspace:*',
    });
  });
});
