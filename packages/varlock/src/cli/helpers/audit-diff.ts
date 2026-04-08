export function diffSchemaAndCodeKeys(schemaKeys: Array<string>, codeKeys: Array<string>) {
  const schemaSet = new Set(schemaKeys);
  const codeSet = new Set(codeKeys);

  const missingInSchema = [...codeSet].filter((k) => !schemaSet.has(k)).sort((a, b) => a.localeCompare(b));
  const unusedInSchema = [...schemaSet].filter((k) => !codeSet.has(k)).sort((a, b) => a.localeCompare(b));

  return {
    missingInSchema,
    unusedInSchema,
  };
}
