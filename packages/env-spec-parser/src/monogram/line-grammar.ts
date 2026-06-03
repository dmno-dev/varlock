import {
  defineGrammar, many, rule, token,
} from './runtime/api';

// This spike grammar tokenizes env-spec files into logical lines.
// We intentionally keep the grammar small and stable while we iterate
// on semantic parsing/parity in a separate transformation layer.
const Line = token(/[^\n]*(?:\n|$)/);

const File = rule(() => [[many(Line)]]);

export const lineGrammar = defineGrammar({
  name: 'env-spec-lines',
  tokens: { Line },
  rules: { File },
  entry: File,
});
