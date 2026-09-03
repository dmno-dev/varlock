import { ParsedEnvSpecFile } from './classes.js';
export * from './classes.js';
export * from './updater';
export * from './expand';
// exported so tooling can classify unquoted scalars the same way the parser does
export { autoCoerce } from './helpers';

// @ts-ignore
import * as peggyParser from './grammar.js';

export function parseEnvSpecDotEnvFile(source: string): ParsedEnvSpecFile {
  return peggyParser.parse(source.replaceAll('\r\n', '\n'));
}
