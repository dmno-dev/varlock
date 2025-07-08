import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../src';

function sensitiveInferenceTests(
  tests: Array<{
    label: string;
    headers: string;
    values: string;
    expected: Record<string, boolean>;
  }>,
) {
  return () => {
    tests.forEach(({
      label, headers, values, expected,
    }) => {
      it(label, async () => {
        const g = new EnvGraph();
        const input = `${headers}\n# ---\n\n${values}`;
        const testDataSource = new DotEnvFileDataSource('.env.schema', { overrideContents: input });
        g.addDataSource(testDataSource);
        await testDataSource.finishInit();
        await g.finishLoad();
        for (const key in expected) {
          const item = g.configSchema[key];
          expect(item.isSensitive).toBe(expected[key]);
        }
      });
    });
  };
}

describe('@defaultSensitive inferFromPrefix', sensitiveInferenceTests([
  {
    label: 'key matches prefix is not sensitive',
    headers: outdent`# @defaultSensitive=inferFromPrefix(PUBLIC_)`,
    values: outdent`
      PUBLIC_FOO=bar
      SECRET_BAR=baz
    `,
    expected: { PUBLIC_FOO: false, SECRET_BAR: true },
  },
  {
    label: 'key does not match prefix is sensitive',
    headers: outdent`# @defaultSensitive=inferFromPrefix(PUBLIC_)`,
    values: outdent`
      FOO=bar
      PUBLIC_BAR=baz
    `,
    expected: { FOO: true, PUBLIC_BAR: false },
  },
  {
    label: 'explicit @sensitive overrides defaultSensitive',
    headers: outdent`# @defaultSensitive=inferFromPrefix(PUBLIC_)`,
    values: outdent`
      # @sensitive=false
      SECRET_BAR=baz
      # @sensitive=true
      PUBLIC_FOO=bar
    `,
    expected: { SECRET_BAR: false, PUBLIC_FOO: true },
  },
  {
    label: 'static @defaultSensitive=true/false still works',
    headers: outdent`# @defaultSensitive=true`,
    values: outdent`
      FOO=bar
      BAR=baz
    `,
    expected: { FOO: true, BAR: true },
  },
  {
    label: 'static @defaultSensitive=false still works',
    headers: outdent`# @defaultSensitive=false`,
    values: outdent`
      FOO=bar
      BAR=baz
    `,
    expected: { FOO: false, BAR: false },
  },
]));
