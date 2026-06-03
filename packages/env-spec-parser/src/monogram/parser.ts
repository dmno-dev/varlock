import { ParsedEnvSpecFile } from '../classes';
import { createParser } from './runtime/gen-parser';
import { lineGrammar } from './line-grammar';
import { parseStrictMonogramSource } from './strict-parser';

const monogramLineParser = createParser(lineGrammar);

export interface MonogramParseStats {
  lineCount: number;
}

export interface MonogramParseOptions {
  onStats?: (stats: MonogramParseStats) => void;
}

function collectMonogramStats(source: string): { lineCount: number } {
  const cst = monogramLineParser.parse(source);
  return {
    lineCount: cst.children.length,
  };
}

export function parseWithMonogram(source: string, options: MonogramParseOptions = {}): ParsedEnvSpecFile {
  const normalizedSource = source.replaceAll('\r\n', '\n');
  const { lineCount } = collectMonogramStats(normalizedSource);
  options.onStats?.({ lineCount });
  return parseStrictMonogramSource(normalizedSource);
}
