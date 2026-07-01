import path from 'node:path';
import { pathExists } from '@env-spec/utils/fs-utils';

export type TypegenLangChoice = {
  /** code-generation root decorator to add, e.g. `generateTsTypes` */
  decorator: string;
  /** bare function args string for the decorator, e.g. `path=env.d.ts` */
  args: string;
};

// checked in order; first match wins. package.json (JS/TS) takes precedence since it's the most
// common and our JS integrations depend on it. Extend this table to support more languages.
const DETECTION_RULES: Array<{ files: Array<string>, choice: TypegenLangChoice }> = [
  { files: ['package.json'], choice: { decorator: 'generateTsTypes', args: 'path=env.d.ts' } },
  { files: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'], choice: { decorator: 'generatePythonTypes', args: 'path=env_types.py' } },
  { files: ['go.mod'], choice: { decorator: 'generateGoTypes', args: 'path=env_types.go' } },
  { files: ['Cargo.toml'], choice: { decorator: 'generateRustTypes', args: 'path=src/env_types.rs' } },
  { files: ['composer.json'], choice: { decorator: 'generatePhpTypes', args: 'path=env_types.php' } },
];

// fall back to TS — it's the richest generator and harmless if unused
const DEFAULT_CHOICE: TypegenLangChoice = { decorator: 'generateTsTypes', args: 'path=env.d.ts' };

/** Detect the primary project language and pick a matching code-gen decorator + default output path. */
export async function detectTypegenDecorator(dir = process.cwd()): Promise<TypegenLangChoice> {
  for (const rule of DETECTION_RULES) {
    for (const file of rule.files) {
      if (await pathExists(path.join(dir, file))) return rule.choice;
    }
  }
  return DEFAULT_CHOICE;
}
