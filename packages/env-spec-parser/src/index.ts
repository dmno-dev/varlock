import { ParsedEnvSpecFile } from './classes.js';
export * from './classes.js';
export * from './updater';
export * from './expand';

// @ts-ignore
import * as peggyParser from './grammar.js';

export function parseEnvSpecDotEnvFile(source: string): ParsedEnvSpecFile {
  return peggyParser.parse(source.replaceAll('\r\n', '\n'));
}
