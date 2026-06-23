export type LineDocument = {
  lineCount: number;
  lineAt(line: number): { text: string };
};

export function createLineDocument(lines: Array<string>): LineDocument {
  return {
    lineCount: lines.length,
    lineAt(line) {
      return { text: lines[line] ?? '' };
    },
  };
}
