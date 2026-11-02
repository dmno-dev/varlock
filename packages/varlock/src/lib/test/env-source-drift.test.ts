import {
  describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EnvGraph } from '../../env-graph';
import { DirectoryDataSource } from '../../env-graph/lib/data-source';
import { checkEnvSourceDrift } from '../env-source-fingerprint';

let tempDir: string;

beforeEach(() => {
  // realpath so paths aren't confused by symlinked tmp dirs (e.g. /tmp on macOS)
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-source-drift-')));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeFile(relPath: string, contents: string) {
  fs.mkdirSync(path.dirname(path.join(tempDir, relPath)), { recursive: true });
  fs.writeFileSync(path.join(tempDir, relPath), contents);
}

async function loadSerializedGraph() {
  const g = new EnvGraph();
  g.basePath = tempDir;
  await g.setRootDataSource(new DirectoryDataSource(tempDir));
  await g.finishLoad();
  await g.resolveEnvValues();
  return g.getSerializedGraph();
}

describe('getSerializedGraph absentSourcePaths', () => {
  test('records auto-load candidates that did not exist', async () => {
    writeFile('.env.schema', 'FOO=bar\n');
    const graph = await loadSerializedGraph();
    expect(graph.absentSourcePaths).toEqual(expect.arrayContaining(['.env', '.env.local']));
    expect(graph.absentSourcePaths).not.toContain('.env.schema');
  });

  test('records env-specific candidates for the resolved current env', async () => {
    writeFile('.env.schema', '# @currentEnv=$APP_ENV\n# ---\nAPP_ENV=staging\n');
    writeFile('.env.staging', 'FOO=bar\n');
    const graph = await loadSerializedGraph();
    expect(graph.absentSourcePaths).toContain('.env.staging.local');
    expect(graph.absentSourcePaths).not.toContain('.env.staging');
  });

  test('records missing allowMissing imports', async () => {
    writeFile('.env.schema', '# @import(./shared/.env.shared, allowMissing=true)\n# ---\nFOO=bar\n');
    const graph = await loadSerializedGraph();
    expect(graph.absentSourcePaths).toContain(path.join('shared', '.env.shared'));
  });
});

describe('checkEnvSourceDrift', () => {
  test('no drift when nothing changed', async () => {
    writeFile('.env.schema', 'FOO=bar\n');
    const graph = await loadSerializedGraph();
    expect(checkEnvSourceDrift(graph)).toEqual({ drifted: false });
  });

  test('drift when a loaded source was edited', async () => {
    writeFile('.env.schema', 'FOO=bar\n');
    const graph = await loadSerializedGraph();
    writeFile('.env.schema', 'FOO=edited\n');
    expect(checkEnvSourceDrift(graph)).toMatchObject({ drifted: true, reason: expect.stringContaining('changed since') });
  });

  test('drift when a loaded source was removed', async () => {
    writeFile('.env.schema', 'FOO=bar\n');
    writeFile('.env', 'FOO=baz\n');
    const graph = await loadSerializedGraph();
    fs.unlinkSync(path.join(tempDir, '.env'));
    expect(checkEnvSourceDrift(graph)).toMatchObject({ drifted: true, reason: expect.stringContaining('missing') });
  });

  test('drift when a file a load would pick up was created', async () => {
    writeFile('.env.schema', 'FOO=bar\n');
    const graph = await loadSerializedGraph();
    writeFile('.env.local', 'FOO=local\n');
    expect(checkEnvSourceDrift(graph)).toMatchObject({ drifted: true, reason: expect.stringContaining('created') });
  });

  test('no drift when an unrelated .env-like file appears', async () => {
    writeFile('.env.schema', 'FOO=bar\n');
    const graph = await loadSerializedGraph();
    writeFile('.env.example', 'FOO=example\n');
    expect(checkEnvSourceDrift(graph)).toEqual({ drifted: false });
  });

  test('a graph from an older producer without absentSourcePaths only checks recorded sources', async () => {
    writeFile('.env.schema', 'FOO=bar\n');
    const graph = await loadSerializedGraph();
    delete graph.absentSourcePaths;
    writeFile('.env.local', 'FOO=local\n');
    expect(checkEnvSourceDrift(graph)).toEqual({ drifted: false });
  });

  test('a source without a fingerprint counts as drift', async () => {
    writeFile('.env.schema', 'FOO=bar\n');
    const graph = await loadSerializedGraph();
    delete graph.sources.find((s) => s.path === '.env.schema')!.contentHash;
    expect(checkEnvSourceDrift(graph)).toMatchObject({ drifted: true, reason: expect.stringContaining('fingerprint') });
  });

  describe('non-regular sources (e.g. 1Password Environments FIFOs)', () => {
    async function graphWithNonRegularSource() {
      writeFile('.env.schema', 'FOO=bar\n');
      const graph = await loadSerializedGraph();
      // swap the file for a directory: same "not a regular file" stat result as a FIFO,
      // without the risk of blocking on an open
      fs.unlinkSync(path.join(tempDir, '.env.schema'));
      fs.mkdirSync(path.join(tempDir, '.env.schema'));
      return graph;
    }

    test('count as drift by default (contents cannot be verified without reading)', async () => {
      const graph = await graphWithNonRegularSource();
      expect(checkEnvSourceDrift(graph)).toMatchObject({ drifted: true, reason: expect.stringContaining('regular file') });
    });

    test('can be treated as unchanged by callers that only care about local edits', async () => {
      const graph = await graphWithNonRegularSource();
      expect(checkEnvSourceDrift(graph, { nonRegularFiles: 'assume-unchanged' })).toEqual({ drifted: false });
    });
  });
});
