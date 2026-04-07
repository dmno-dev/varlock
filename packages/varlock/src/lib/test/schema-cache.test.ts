import {
  describe, test, expect, vi, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { clearSchemasCache, clearPluginsCache, clearAllCaches } from '../../lib/schema-cache';

describe('schema-cache', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'varlock-cache-test-'));
    vi.stubEnv('XDG_CONFIG_HOME', tmpDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('clearSchemasCache', () => {
    test('clears schemas cache directory', async () => {
      const schemasDir = path.join(tmpDir, 'varlock', 'schemas-cache');
      await fs.mkdir(schemasDir, { recursive: true });
      await fs.writeFile(path.join(schemasDir, 'test.env'), 'TEST=1');

      await clearSchemasCache();

      const exists = await fs.stat(schemasDir).then(() => true, () => false);
      expect(exists).toBe(false);
    });

    test('does not error when directory does not exist', async () => {
      await expect(clearSchemasCache()).resolves.not.toThrow();
    });
  });

  describe('clearPluginsCache', () => {
    test('clears plugins cache directory', async () => {
      const pluginsDir = path.join(tmpDir, 'varlock', 'plugins-cache');
      await fs.mkdir(pluginsDir, { recursive: true });
      await fs.writeFile(path.join(pluginsDir, 'test.tgz'), 'dummy');

      await clearPluginsCache();

      const exists = await fs.stat(pluginsDir).then(() => true, () => false);
      expect(exists).toBe(false);
    });
  });

  describe('clearAllCaches', () => {
    test('clears both schemas and plugins caches', async () => {
      const schemasDir = path.join(tmpDir, 'varlock', 'schemas-cache');
      const pluginsDir = path.join(tmpDir, 'varlock', 'plugins-cache');
      await fs.mkdir(schemasDir, { recursive: true });
      await fs.mkdir(pluginsDir, { recursive: true });
      await fs.writeFile(path.join(schemasDir, 'test.env'), 'TEST=1');
      await fs.writeFile(path.join(pluginsDir, 'test.tgz'), 'dummy');

      await clearAllCaches();

      const schemasExists = await fs.stat(schemasDir).then(() => true, () => false);
      const pluginsExists = await fs.stat(pluginsDir).then(() => true, () => false);
      expect(schemasExists).toBe(false);
      expect(pluginsExists).toBe(false);
    });
  });
});
