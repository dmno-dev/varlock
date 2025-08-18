import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../index';

function disableRootDecoratorTests(
  tests: Array<{
    label: string;
    headers: string;
    values: string;
    expectedKeys: Array<string>;
    expectedDisabled: boolean;
  }>,
) {
  return () => {
    tests.forEach(({
      label, headers, values, expectedKeys, expectedDisabled,
    }) => {
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
    headers: outdent`# @disable=true`,
    values: outdent`
      FOO=bar
      BAR=baz
    `,
    expectedKeys: [],
    expectedDisabled: true,
  },
  {
    label: 'does not disable data source when @disable is false',
    headers: outdent`# @disable=false`,
    values: outdent`
      FOO=bar
      BAR=baz
    `,
    expectedKeys: ['BAR', 'FOO'],
    expectedDisabled: false,
  },
  {
    label: 'disables data source with just @disable (no value)',
    headers: outdent`# @disable`,
    values: outdent`
      FOO=bar
      BAR=baz
    `,
    expectedKeys: [],
    expectedDisabled: true,
  },
]));
