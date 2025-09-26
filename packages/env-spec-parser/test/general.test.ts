
import { it, expect } from 'vitest';
import { parseEnvSpecDotEnvFile } from '../src';
import { simpleResolver } from '../src/simple-resolver';

function generalTest(spec: {
  input: string;
  env?: Record<string, string>;
  expected: Record<string, any> | Error
}) {
  return () => {
    const { input, env, expected } = spec;

    if (expected instanceof Error) {
      // TODO: should prob split between parse error vs resolve error?
      expect(() => parseEnvSpecDotEnvFile(input)).toThrow();
    } else {
      const parsedFile = parseEnvSpecDotEnvFile(input);
      const resolved = simpleResolver(parsedFile, { env: env ?? {} });
      for (const key in expected) {
        expect(resolved[key]).toEqual(expected[key]);
      }
    }
  };
}

it('supports \\r\\n style newlines', generalTest({
  input: 'FOO=foo\r\nBAR=bar\r\n',
  expected: {
    FOO: 'foo',
    BAR: 'bar',
  },
}));
