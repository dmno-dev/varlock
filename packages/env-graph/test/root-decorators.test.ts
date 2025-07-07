import { describe, it, expect } from 'vitest';
import { DotEnvFileDataSource, EnvGraph } from '../src';

function disableRootDecoratorTests(
  tests: Array<{
    label: string;
    headers: string;
    values: string;
    expectedKeys: string[];
    expectedDisabled: boolean;
  }>,
) {
  return () => {
    tests.forEach(({ label, headers, values, expectedKeys, expectedDisabled }) => {
      it(label, async () => {
        const g = new EnvGraph();
        const input = `${headers}\n# ---\n\n${values}`;
        const testDataSource = new DotEnvFileDataSource('.env.schema', { overrideContents: input });
        g.addDataSource(testDataSource);
        await testDataSource.finishInit();
        await g.finishLoad();
        expect(Object.keys(g.configSchema).sort()).toEqual(expectedKeys.sort());
        expect(!!testDataSource.disabled).toBe(expectedDisabled);
      });
    });
  };
}

describe('@disable root decorator', disableRootDecoratorTests([
  {
    label: 'skips loading config items from a disabled data source',
    headers: '# @disable=true',
    values: 'FOO=bar\nBAR=baz',
    expectedKeys: [],
    expectedDisabled: true,
  },
  {
    label: 'does not disable data source when @disable is false',
    headers: '# @disable=false',
    values: 'FOO=bar\nBAR=baz',
    expectedKeys: ['BAR', 'FOO'],
    expectedDisabled: false,
  },
  {
    label: 'disables data source with just @disable (no value)',
    headers: '# @disable',
    values: 'FOO=bar\nBAR=baz',
    expectedKeys: [],
    expectedDisabled: true,
  },
]));