import { describe, expect, test } from 'vitest';
import outdent from 'outdent';

import { builtInCodeGenerators, generatePwshEnvSrc } from '../../index';
import { loadFixtureFields } from './helpers';

const typeId = (src: string) => /Varlock\.Pwsh_([0-9a-f]{12})\.Env/.exec(src)?.[1];

describe('generatePwshEnvSrc', () => {
  test('wraps the generated C# class in Add-Type and adds a parameterless Get-Env', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      DB_HOST=localhost  # @required @public
      DB_PORT=5432       # @optional @public
      API_KEY=secret     # @required @sensitive
    `);
    const src = generatePwshEnvSrc(fields);

    expect(src).toMatch(/if \(-not \('Varlock\.Pwsh_[0-9a-f]{12}\.Env' -as \[type\]\)\) \{/);
    expect(src).toContain('Add-Type -CompilerOptions \'/define:NET8_0_OR_GREATER\' -TypeDefinition @\'');
    expect(src).toContain('#nullable enable');
    expect(src).toMatch(/namespace Varlock\.Pwsh_[0-9a-f]{12};/);
    expect(src).toContain('function Get-EnvSensitiveKeys {');
    expect(src).toContain('@(\'API_KEY\')');
    expect(src).not.toContain('::SensitiveKeys');
    expect(src).toContain('function Get-Env {');
    expect(src).toContain('[CmdletBinding()]');
    expect(src).toMatch(/\[OutputType\('Varlock\.Pwsh_[0-9a-f]{12}\.Env'\)\]/);
    expect(src).toContain('    param()');
    expect(src).toContain('::Load()');
    expect(src).not.toContain('[switch]');
    expect(src).not.toContain('ParameterSetName');
  });

  test('functionName= sets the function name', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      DB_HOST=localhost  # @required @public
    `);
    const src = generatePwshEnvSrc(fields, { functionName: 'Get-AppEnv' });
    expect(src).toContain('function Get-AppEnv {');
    expect(src).toContain('function Get-AppEnvSensitiveKeys {');
    expect(src).not.toContain('Get-Env {');
  });

  test('the namespace only depends on the generated C#, so a changed schema gets a new type', async () => {
    const { fields: a } = await loadFixtureFields(outdent`
      # ---
      DB_HOST=localhost  # @required @public
    `);
    const { fields: b } = await loadFixtureFields(outdent`
      # ---
      DB_HOST=localhost  # @required @public
      DB_PORT=5432       # @optional @public
    `);
    expect(typeId(generatePwshEnvSrc(a))).toBeDefined();
    expect(typeId(generatePwshEnvSrc(a))).not.toBe(typeId(generatePwshEnvSrc(b)));
    expect(typeId(generatePwshEnvSrc(a, { functionName: 'Get-Other' }))).toBe(typeId(generatePwshEnvSrc(a)));
  });

  test('rejects a function name that is not Verb-Noun', async () => {
    const { fields } = await loadFixtureFields();
    expect(() => generatePwshEnvSrc(fields, { functionName: 'GetEnv' })).toThrow(/function/);
    expect(() => generatePwshEnvSrc(fields, { functionName: 'Get-App Env' })).toThrow(/function/);
    expect(() => generatePwshEnvSrc(fields, { functionName: 'Get-$(calc)' })).toThrow(/function/);
  });

  test('help lists each property with its type and description', async () => {
    const { fields } = await loadFixtureFields(outdent`
      # @defaultSensitive=false
      # ---
      DB_HOST=localhost  # @required @public @sensitive
      # @type=port
      DB_PORT=5432       # @optional @public
    `);
    const src = generatePwshEnvSrc(fields);
    expect(src).toContain('Properties:');
    expect(src).toMatch(/DbHost\s+string\s+\(sensitive\)/);
    expect(src).toMatch(/DbPort\s+long\?/);
    expect(src).toContain('.OUTPUTS');
    expect(src).toContain('(Get-Env).DbHost');
    expect(src).not.toContain('# >');
  });

  test('is registered as the generatePwshEnv decorator', () => {
    const def = builtInCodeGenerators.find((d) => d.decoratorName === 'generatePwshEnv');
    expect(def).toBeDefined();
    expect(def?.knownOptions).toEqual(['functionName']);
  });
});
