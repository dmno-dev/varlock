/**
 * keychain() on platforms without a Keychain. These paths never reach the native daemon,
 * so they can run anywhere by stubbing process.platform.
 */

import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import { outdent } from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../../env-graph';
import { ResolutionError, SchemaError } from '../../env-graph/lib/errors';
import { KeychainResolver } from './keychain-resolver';

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

async function loadSchema(contents: string) {
  const g = new EnvGraph();
  g.registerResolver(KeychainResolver);
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', { overrideContents: contents }));
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

describe('keychain() on non-macOS', () => {
  beforeEach(() => setPlatform('linux'));
  afterEach(() => setPlatform(realPlatform));

  it('does not break the schema when it sits in a branch that is not taken', async () => {
    const g = await loadSchema(outdent`
      # ---
      API_KEY=if(eq($VARLOCK_OS, "darwin"), keychain("my-app", account="api"), "from-other-source")
    `);
    expect(g.configSchema.API_KEY.errors).toEqual([]);
    expect(g.configSchema.API_KEY.resolvedValue).toBe('from-other-source');
  });

  it('lets fallback() move on when allowMissing=true', async () => {
    const g = await loadSchema(outdent`
      # ---
      API_KEY=fallback(keychain("my-app", account="api", allowMissing=true), "from-other-source")
    `);
    expect(g.configSchema.API_KEY.errors).toEqual([]);
    expect(g.configSchema.API_KEY.resolvedValue).toBe('from-other-source');
  });

  it('fails with a resolution error that suggests the alternatives', async () => {
    const g = await loadSchema(outdent`
      # ---
      API_KEY=keychain("my-app", account="api")
    `);
    const [err] = g.configSchema.API_KEY.errors;
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err.message).toContain('only supported on macOS');
    expect(String((err as ResolutionError).tip)).toContain('allowMissing=true');
  });
});

describe('keychain() args', () => {
  it('rejects a service given both positionally and by name', async () => {
    const g = await loadSchema(outdent`
      # ---
      API_KEY=keychain("a", service="b")
    `);
    expect(g.configSchema.API_KEY.errors[0]).toBeInstanceOf(SchemaError);
  });
});
