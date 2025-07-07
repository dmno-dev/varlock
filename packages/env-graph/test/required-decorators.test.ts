import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../src';

function requiredInferenceTests(
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
          expect(item.isRequired).toBe(expected[key]);
        }
      });
    });
  };
}

describe('@defaultRequired root decorator', requiredInferenceTests([
  {
    label: 'static value is required',
    headers: outdent`# @defaultRequired=infer`,
    values: outdent`FOO=bar`,
    expected: { FOO: true },
  },
  {
    label: 'static value with empty string is not required',
    headers: outdent`# @defaultRequired=infer`,
    values: outdent`FOO=''`,
    expected: { FOO: false },
  },
  {
    label: 'no value is not required',
    headers: outdent`# @defaultRequired=infer`,
    values: outdent`FOO=`,
    expected: { FOO: false },
  },
  {
    label: 'function value is required',
    headers: outdent`# @defaultRequired=infer`,
    values: outdent`BAR=fnCall()`,
    expected: { BAR: true },
  },
  {
    label: 'explicit optional overrides infer',
    headers: outdent`# @defaultRequired=infer`,
    values: outdent`
      # @optional
      BAZ=qux

      BAR=val
    `,
    expected: { BAZ: false, BAR: true },
  },
  {
    label: 'explicit required overrides infer',
    headers: outdent`# @defaultRequired=infer`,
    values: outdent`
      # @required
      QUUX=
    `,
    expected: { QUUX: true },
  },
  {
    label: 'static value with explicit required',
    headers: outdent`# @defaultRequired=infer`,
    values: outdent`
      # @required
      FOO=bar
    `,
    expected: { FOO: true },
  },
  {
    label: 'static value with explicit optional',
    headers: outdent`# @defaultRequired=infer`,
    values: outdent`
      # @optional
      FOO=bar
    `,
    expected: { FOO: false },
  },
  {
    label: '@defaultRequired=true makes all required',
    headers: outdent`# @defaultRequired=true`,
    values: outdent`
      FOO=bar
      BAR=
    `,
    expected: { FOO: true, BAR: true },
  },
  {
    label: '@defaultRequired=false makes all not required',
    headers: outdent`# @defaultRequired=false`,
    values: outdent`
      FOO=bar
      BAR=
      BAZ=fnCall()
    `,
    expected: { FOO: false, BAR: false, BAZ: false },
  },
  {
    label: 'no @defaultRequired set, required by default',
    headers: outdent``,
    values: outdent`
      FOO=bar
      BAR=
    `,
    expected: { FOO: true, BAR: true },
  },
  {
    label: '@optional=false makes required',
    headers: outdent`# @defaultRequired=false`,
    values: outdent`
      # @optional=false
      FOO=bar
    `,
    expected: { FOO: true },
  },
  {
    label: '@required=false makes not required',
    headers: outdent`# @defaultRequired=true`,
    values: outdent`
      # @required=false
      BAR=val
    `,
    expected: { BAR: false },
  },
]));
