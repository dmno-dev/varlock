import { describe, it, expect } from 'vitest';
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
    tests.forEach(({ label, headers, values, expected }) => {
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
    headers: '# @defaultRequired=infer',
    values: 'FOO=bar',
    expected: { FOO: true },
  },
  {
    label: 'static value with empty string is not required',
    headers: '# @defaultRequired=infer',
    values: "FOO=''",
    expected: { FOO: false },
  },
  {
    label: 'no value is not required',
    headers: '# @defaultRequired=infer',
    values: 'FOO=',
    expected: { FOO: false },
  },
  {
    label: 'function value is required',
    headers: '# @defaultRequired=infer',
    values: 'BAR=fnCall()',
    expected: { BAR: true },
  },
  {
    label: 'explicit optional overrides infer',
    headers: '# @defaultRequired=infer',
    values: '# @optional\nBAZ=qux\n\nBAR=val',
    expected: { BAZ: false, BAR: true },
  },
  {
    label: 'explicit required overrides infer',
    headers: '# @defaultRequired=infer',
    values: '# @required\nQUUX=',
    expected: { QUUX: true },
  },
  {
    label: 'static value with explicit required',
    headers: '# @defaultRequired=infer',
    values: '# @required\nFOO=bar',
    expected: { FOO: true },
  },
  {
    label: 'static value with explicit optional',
    headers: '# @defaultRequired=infer',
    values: '# @optional\nFOO=bar',
    expected: { FOO: false },
  },
  {
    label: '@defaultRequired=true makes all required',
    headers: '# @defaultRequired=true',
    values: 'FOO=bar\nBAR=',
    expected: { FOO: true, BAR: true },
  },
  {
    label: '@defaultRequired=false makes all not required',
    headers: '# @defaultRequired=false',
    values: 'FOO=bar\nBAR=\nBAZ=fnCall()',
    expected: { FOO: false, BAR: false, BAZ: false },
  },
])); 