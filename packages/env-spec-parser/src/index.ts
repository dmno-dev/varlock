import { ParsedEnvSpecFile } from './classes.js';
export * from './classes.js';
export * from './updater';
export * from './expand';
export { parseWithMonogram } from './monogram/parser';
import { parseWithMonogram } from './monogram/parser';

export function parseEnvSpecDotEnvFile(source: string): ParsedEnvSpecFile {
  return parseWithMonogram(source);
}
