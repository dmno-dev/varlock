import { ParsedEnvSpecFile } from './classes.js';
export * from './classes.js';

import * as peggyParser from './grammar.js';

export function parseEnvSpecDotEnvFile(source: string): ParsedEnvSpecFile {
  return peggyParser.parse(source);
}

