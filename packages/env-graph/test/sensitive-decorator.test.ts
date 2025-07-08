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
    label: 'base case @defaultSensitive=inferFromPrefix',
    headers: outdent`# @defaultSensitive=inferFromPrefix(PUBLIC_)`,
    values: outdent`
      PUBLIC_FOO=bar
      BAR=baz
    `,
    expected: { PUBLIC_FOO: false, BAR: true },
  },
  {
    label: 'key matches prefix is not sensitive (with explicit override)',
    headers: outdent`# @defaultSensitive=inferFromPrefix(PUBLIC_)`,
    values: outdent`
      PUBLIC_FOO=bar
      # @sensitive=true
      SECRET_BAR=baz
    `,
    expected: { PUBLIC_FOO: false, SECRET_BAR: true },
  },
  {
    label: 'key does not match prefix is sensitive (with explicit override)',
    headers: outdent`# @defaultSensitive=inferFromPrefix(PUBLIC_)`,
    values: outdent`
      # @sensitive=false
      FOO=bar
      PUBLIC_BAR=baz
    `,
    expected: { FOO: false, PUBLIC_BAR: false },
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
    label: 'static @defaultSensitive=true still works',
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
  {
    label: 'no @defaultSensitive set, sensitive by default',
    headers: outdent``,
    values: outdent`
      FOO=bar
      BAR=baz
    `,
    expected: { FOO: true, BAR: true },
  },
]));
