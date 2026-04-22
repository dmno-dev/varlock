import { describe, it, expect } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';
import { EnvGraph } from '../index';
import { DotEnvFileDataSource } from '../lib/data-source';
import { SchemaError } from '../lib/errors';

describe('@deprecated item decorator', () => {
  it('bare @deprecated emits a warning and item still resolves', envFilesTest({
    envFile: outdent`
      # @defaultRequired=false
      # ---
      # @deprecated
      MY_VAR=hello
    `,
    expectValues: {
      MY_VAR: 'hello',
    },
  }));

  it('@deprecated=true emits a warning and item still resolves', envFilesTest({
    envFile: outdent`
      # @defaultRequired=false
      # ---
      # @deprecated=true
      MY_VAR=hello
    `,
    expectValues: {
      MY_VAR: 'hello',
    },
  }));

  it('@deprecated with a string message includes the message in the warning', async () => {
    const g = new EnvGraph();
    const source = new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @defaultRequired=false
        # ---
        # @deprecated="Use NEW_VAR instead"
        MY_VAR=hello
      `,
    });
    await g.setRootDataSource(source);
    await g.finishLoad();
    await g.resolveEnvValues();

    const item = g.configSchema.MY_VAR;
    expect(item.resolvedValue).toBe('hello');
    const warnings = item.errors.filter((e) => e.isWarning);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].message).toContain('Use NEW_VAR instead');
  });

  it('@deprecated=false does not emit a warning', async () => {
    const g = new EnvGraph();
    const source = new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @defaultRequired=false
        # ---
        # @deprecated=false
        MY_VAR=hello
      `,
    });
    await g.setRootDataSource(source);
    await g.finishLoad();
    await g.resolveEnvValues();

    const item = g.configSchema.MY_VAR;
    expect(item.resolvedValue).toBe('hello');
    expect(item.isValid).toBe(true);
    expect(item.errors.length).toBe(0);
  });

  it('@deprecated only emits a warning, not an error (validationState=warn)', async () => {
    const g = new EnvGraph();
    const source = new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @defaultRequired=false
        # ---
        # @deprecated
        MY_VAR=hello
      `,
    });
    await g.setRootDataSource(source);
    await g.finishLoad();
    await g.resolveEnvValues();

    const item = g.configSchema.MY_VAR;
    expect(item.validationState).toBe('warn');
    expect(item.errors.every((e) => e.isWarning)).toBe(true);
    expect(item.errors[0]).toBeInstanceOf(SchemaError);
    expect(item.errors[0].message).toContain('deprecated');
  });

  it('isDeprecated getter returns true when @deprecated is set', async () => {
    const g = new EnvGraph();
    const source = new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @defaultRequired=false
        # ---
        # @deprecated="Use NEW_VAR instead"
        MY_VAR=hello
        # @deprecated=false
        NOT_DEPRECATED=world
        ALSO_NOT_DEPRECATED=foo
      `,
    });
    await g.setRootDataSource(source);
    await g.finishLoad();
    await g.resolveEnvValues();

    expect(g.configSchema.MY_VAR.isDeprecated).toBe(true);
    expect(g.configSchema.MY_VAR.deprecationMessage).toBe('Use NEW_VAR instead');
    expect(g.configSchema.NOT_DEPRECATED.isDeprecated).toBe(false);
    expect(g.configSchema.ALSO_NOT_DEPRECATED.isDeprecated).toBe(false);
  });

  it('@deprecated is included in type gen info', async () => {
    const g = new EnvGraph();
    const source = new DotEnvFileDataSource('.env.schema', {
      overrideContents: outdent`
        # @defaultRequired=false
        # ---
        # @deprecated="Use NEW_VAR instead"
        MY_VAR=hello
        NORMAL_VAR=world
      `,
    });
    await g.setRootDataSource(source);
    await g.finishLoad();

    const deprecatedInfo = await g.configSchema.MY_VAR.getTypeGenInfo();
    expect(deprecatedInfo.isDeprecated).toBe(true);
    expect(deprecatedInfo.deprecationMessage).toBe('Use NEW_VAR instead');

    const normalInfo = await g.configSchema.NORMAL_VAR.getTypeGenInfo();
    expect(normalInfo.isDeprecated).toBe(false);
    expect(normalInfo.deprecationMessage).toBeUndefined();
  });
});
