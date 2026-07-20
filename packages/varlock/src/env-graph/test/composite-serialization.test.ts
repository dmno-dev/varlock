/*
  Tests for how composite (array/object) values serialize back out:
  - `resolvedEnvStringValue` / getResolvedEnvStringObject (process.env injection)
  - `envStr` in the serialized graph blob
  - redaction map registration of composite elements
*/

import { describe, it, expect } from 'vitest';
import { outdent } from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../index';
import { resetRedactionMap, redactSensitiveConfig } from '../../runtime/env';

async function loadAndResolve(envFileContent: string) {
  const g = new EnvGraph();
  const testDataSource = new DotEnvFileDataSource('.env.schema', {
    overrideContents: outdent`
      # @defaultRequired=false
      # ---
      ${envFileContent}
    `,
  });
  await g.setRootDataSource(testDataSource);
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

describe('composite value serialization', () => {
  it('arrays of scalars join with the default separator', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string)
      ITEM=[a, b, c]
    `);
    expect(g.configSchema.ITEM.resolvedEnvStringValue).toBe('a,b,c');
  });

  it('arrays join with a custom separator', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string, separator=";")
      ITEM=[a, b]
    `);
    expect(g.configSchema.ITEM.resolvedEnvStringValue).toBe('a;b');
  });

  it('array elements serialize with their element type (booleans/numbers)', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(number)
      PORTS=[8080, 3000]
    `);
    expect(g.configSchema.PORTS.resolvedEnvStringValue).toBe('8080,3000');
  });

  it('format=json emits a JSON array', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string, format=json)
      ITEM=[a, b]
    `);
    expect(g.configSchema.ITEM.resolvedEnvStringValue).toBe('["a","b"]');
  });

  it('arrays of composites force JSON regardless of format', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(object)
      ITEMS=[{name=a}, {name=b}]
    `);
    expect(g.configSchema.ITEMS.resolvedEnvStringValue).toBe('[{"name":"a"},{"name":"b"}]');
  });

  it('objects serialize as JSON', async () => {
    const g = await loadAndResolve(outdent`
      # @type=object(number)
      LIMITS={low=1, high=100}
    `);
    expect(g.configSchema.LIMITS.resolvedEnvStringValue).toBe('{"low":1,"high":100}');
  });

  it('scalars pass through unchanged', async () => {
    const g = await loadAndResolve(outdent`
      # @type=number
      PORT=8080
      NAME=hello
    `);
    expect(g.configSchema.PORT.resolvedEnvStringValue).toBe('8080');
    expect(g.configSchema.NAME.resolvedEnvStringValue).toBe('hello');
  });

  it('undefined values stay undefined', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string)
      ITEM=
    `);
    expect(g.configSchema.ITEM.resolvedEnvStringValue).toBe(undefined);
  });

  describe('separator round-trip via string re-parse', () => {
    it('a joined string parses back to the same array', async () => {
      const g = await loadAndResolve(outdent`
        # @type=array(email)
        EMAILS="one@example.com,two@example.com"
      `);
      expect(g.configSchema.EMAILS.resolvedValue).toEqual(['one@example.com', 'two@example.com']);
      expect(g.configSchema.EMAILS.resolvedEnvStringValue).toBe('one@example.com,two@example.com');
    });
  });
});

describe('serialized graph envStr', () => {
  it('includes envStr for composite values only', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string, separator=";")
      ITEM=[a, b]
      # @type=object
      OBJ={k=v}
      # @type=number
      PORT=8080
    `);
    const serialized = g.getSerializedGraph();
    expect(serialized.config.ITEM.envStr).toBe('a;b');
    expect(serialized.config.OBJ.envStr).toBe('{"k":"v"}');
    expect(serialized.config.PORT.envStr).toBe(undefined);
    expect(serialized.config.PORT.value).toBe(8080);
  });
});

describe('composite redaction', () => {
  it('registers each string element of a sensitive array for redaction', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string)
      # @sensitive
      TOKENS=[secret-token-one-xyz, secret-token-two-abc]
    `);
    resetRedactionMap(g.getSerializedGraph());
    const redacted = redactSensitiveConfig('leaked: secret-token-two-abc !');
    expect(redacted).not.toContain('secret-token-two-abc');
  });

  it('registers nested object values of sensitive items', async () => {
    const g = await loadAndResolve(outdent`
      # @type=object
      # @sensitive
      CREDS={user=admin-user-name-x, pass=super-secret-passphrase-1}
    `);
    resetRedactionMap(g.getSerializedGraph());
    const redacted = redactSensitiveConfig('pass is super-secret-passphrase-1');
    expect(redacted).not.toContain('super-secret-passphrase-1');
  });
});

describe('runtime re-injection of composite values (initVarlockEnv)', () => {
  it('injects the envStr flat form into process.env, typed value into ENV', async () => {
    const g = await loadAndResolve(outdent`
      # @type=array(string, separator=";")
      HOSTS=[a.com, b.com]
      # @type=object(number)
      LIMITS={low=1}
      # @type=number
      PORT=8080
    `);
    const { initVarlockEnv, ENV } = await import('../../runtime/env');

    const prevBlob = process.env.__VARLOCK_ENV;
    const prevKeys = { HOSTS: process.env.HOSTS, LIMITS: process.env.LIMITS, PORT: process.env.PORT };
    try {
      process.env.__VARLOCK_ENV = JSON.stringify(g.getSerializedGraph());
      initVarlockEnv();

      // process.env gets the flat string form (separator-joined / JSON)
      expect(process.env.HOSTS).toBe('a.com;b.com');
      expect(process.env.LIMITS).toBe('{"low":1}');
      expect(process.env.PORT).toBe('8080');

      // the ENV proxy exposes the real typed values
      expect((ENV as any).HOSTS).toEqual(['a.com', 'b.com']);
      expect((ENV as any).LIMITS).toEqual({ low: 1 });
      expect((ENV as any).PORT).toBe(8080);
    } finally {
      if (prevBlob === undefined) delete process.env.__VARLOCK_ENV;
      else process.env.__VARLOCK_ENV = prevBlob;
      for (const [k, v] of Object.entries(prevKeys)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
