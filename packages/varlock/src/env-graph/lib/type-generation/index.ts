import fs from 'node:fs';
import type { EnvGraph } from '../env-graph';
import type { TypeGenItemInfo } from '../config-item';
import { isVarlockReservedKey } from '../reserved-vars';
import { generateGoTypesSrc } from './emitters/go';
import { generatePhpTypesSrc } from './emitters/php';
import { generatePythonTypesSrc } from './emitters/python';
import { generateRustTypesSrc } from './emitters/rust';
import { generateTsTypesSrc } from './emitters/ts';
import {
  isSupportedTypeGenLang,
  resolveFieldTypes,
  SUPPORTED_TYPEGEN_LANGS,
  type TypeGenLang,
} from './shared';

export {
  generateTsTypesSrc,
  getTsDefinitionForItem,
} from './emitters/ts';
export {
  generatePythonTypesSrc,
} from './emitters/python';
export {
  generateRustTypesSrc,
} from './emitters/rust';
export {
  generateGoTypesSrc,
} from './emitters/go';
export {
  generatePhpTypesSrc,
} from './emitters/php';
export {
  isSupportedTypeGenLang,
  resolveCoercedType,
  resolveFieldType,
  resolveFieldTypes,
  resolveRawStringType,
  SUPPORTED_TYPEGEN_LANGS,
  type CoercedType,
  type RawStringType,
  type ResolvedFieldType,
  type TypeGenLang,
} from './shared';

async function collectTypeGenItems(graph: EnvGraph): Promise<Array<TypeGenItemInfo>> {
  const items: Array<TypeGenItemInfo> = [];
  for (const itemKey of graph.sortedConfigKeys) {
    if (isVarlockReservedKey(itemKey)) continue;
    const configItem = graph.configSchema[itemKey];
    if (!configItem.defsForTypeGeneration.length) continue;
    items.push(await configItem.getTypeGenInfo());
  }
  return items;
}

async function generateSourceForLang(lang: TypeGenLang, items: Array<TypeGenItemInfo>): Promise<string> {
  const fields = resolveFieldTypes(items);

  switch (lang) {
    case 'ts':
      return generateTsTypesSrc(items);
    case 'py':
      return generatePythonTypesSrc(fields);
    case 'rs':
      return generateRustTypesSrc(fields);
    case 'go':
      return generateGoTypesSrc(fields);
    case 'php':
      return generatePhpTypesSrc(fields);
    default: {
      const exhaustiveCheck: never = lang;
      throw new Error(`Unsupported @generateTypes lang: ${exhaustiveCheck}`);
    }
  }
}

export async function generateTypes(graph: EnvGraph, lang: string, typesPath: string) {
  if (!isSupportedTypeGenLang(lang)) {
    throw new Error(`Unsupported @generateTypes lang: ${lang}. Supported languages: ${SUPPORTED_TYPEGEN_LANGS.join(', ')}`);
  }

  const items = await collectTypeGenItems(graph);
  const src = await generateSourceForLang(lang, items);
  await fs.promises.writeFile(typesPath, src, 'utf-8');
}
