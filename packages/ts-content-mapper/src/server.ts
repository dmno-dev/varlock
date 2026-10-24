// TypeScript 7.1 content mapper: .env.schema -> virtual TypeScript.
// TypeScript starts this file as a separate process (`typescript.contentMapper.exec` in package.json) and talks to
// it over stdio, through the `ts-content-mapper` SDK.
//  canonical output: varlock's own @generateTsTypes output (the types for ENV, including the
//    `declare module 'varlock/env'` augmentation), with keys mapped VERBATIM to the schema
//    (hover, definition, references, highlights, rename, completion), Alias only for non-identifier keys
//  supplemental[0]: a schema API generated from the live registries plus the lowered schema (lower.ts), so schema
//    mistakes are ordinary TS semantic errors located in .env.schema
//  mapper diagnostics: only when the buffer cannot be parsed (they would otherwise mask TS errors under tsc)
// The graph is built in varlock's shape mode (shape.ts): no shell commands, secret stores, network or
// root decorator execute().
//
// Debugging: VARLOCK_MAPPER_LOG=<file> appends one line per transform (tsc drops mapper stderr),
// VARLOCK_MAPPER_DUMP=<dir> writes the canonical and supplemental virtual files.
/* eslint-disable no-bitwise -- SpanMapFeature values are bit flags */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MappedCodeBuilder, runContentMapper, SpanMapFeature as F } from 'ts-content-mapper';
import { loadShapeGraph } from './shape';
import { genSchemaApi } from './schema-api';
import { lowerSchema } from './lower';

type ExposeEnv = 'global' | 'local';
type ImportMode = 'keys' | 'module';
type MapperOptions = { exposeEnv?: ExposeEnv, importMode?: ImportMode };
type Project = { exposeEnv: ExposeEnv, importMode: ImportMode };

const KEY_F = F.Hover | F.Definition | F.TypeDefinition | F.References | F.DocumentHighlights | F.Rename | F.Completion;
const ALIAS_F = F.Hover | F.Definition | F.TypeDefinition | F.References | F.DocumentHighlights;
const IDENT = /^[A-Za-z_$][\w$]*$/;

async function resolveFields(graph: any) {
  const fields = [];
  for (const key of graph.sortedConfigKeys) {
    if (key.startsWith('_VARLOCK_')) continue;
    const item = graph.configSchema[key];
    if (!item.defsForTypeGeneration.length || item.isInternal) continue;
    const info = await item.getTypeGenInfo();
    fields.push({
      key: info.key,
      coerced: info.dataType?.coercedType ?? 'string',
      isRequired: info.isRequired && !info.isRequiredDynamic,
      isSensitive: info.isSensitive,
      docs: {
        description: info.description,
        isDeprecated: info.isDeprecated,
        deprecationMessage: info.deprecationMessage,
        docsLinks: info.docsLinks ?? [],
        icon: info.icon,
      },
    });
  }
  return fields;
}

// offset of each key name in the ORIGINAL buffer (parser offsets are in repaired coordinates)
function keyOffsets(parsedFile: any, T: string, toOrig: (o: number) => number) {
  const out = new Map<string, number>();
  for (const item of parsedFile?.configItems ?? []) {
    const loc = item.data._location;
    if (!loc) continue;
    const slice = T.slice(loc.start.offset, loc.end.offset);
    const m = new RegExp(`^[ \\t]*(?:export[ \\t]+)?(${item.key.replace(/[.]/g, '\\.')})[ \\t]*=`, 'm').exec(slice);
    if (m) out.set(item.key, toOrig(loc.start.offset + m.index + m[0].indexOf(m[1])));
  }
  return out;
}

function envUnionOf(graph: any, source: any) {
  const envKey = source.envFlagKey;
  const en = envKey && graph.configSchema[envKey]?.dataType?.coercedType?.enum;
  return en?.length ? en.map((e: unknown) => JSON.stringify(String(e))).join(' | ') : 'string';
}

function parseDiagnostics(content: string, source: any, loadError: any) {
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);
  const errs = [...(source.errors ?? []), ...(loadError ? [loadError] : [])];
  return (errs.length ? errs : [new Error('unable to parse')]).map((e: any) => {
    const loc = e.location ?? e.more?.location;
    const start = loc?.lineNumber
      ? (lineStarts[loc.lineNumber - 1] ?? 0) + Math.max(0, (loc.colNumber ?? 1) - 1)
      : 0;
    return {
      messageText: e.message as string, start: Math.min(start, content.length), length: 0, code: 1,
    };
  });
}

// debugging aid only: a failure here must never fail the transform
function dumpVirtualFiles(dumpDir: string, fileName: string, canonical: string, supplemental: string) {
  try {
    fs.mkdirSync(dumpDir, { recursive: true });
    // one file name per schema path, short enough for any file system (the mapper's cwd is its own package dir,
    // so a path relative to it can get very long)
    const hash = createHash('sha1').update(fileName).digest('hex').slice(0, 10);
    const tag = `${hash}__${path.basename(path.dirname(fileName))}__${path.basename(fileName)}`;
    fs.writeFileSync(path.join(dumpDir, `${tag}.canonical.ts`), canonical);
    fs.writeFileSync(path.join(dumpDir, `${tag}.supplemental.ts`), supplemental);
  } catch (e) {
    process.stderr.write(`[varlock-mapper] could not write VARLOCK_MAPPER_DUMP: ${(e as Error).message}\n`);
  }
}

export async function transform(
  { fileName, content }: { fileName: string, content: string },
  ctx: { project: Project, positionEncoding: 'utf-8' | 'utf-16' },
) {
  const t0 = performance.now();
  const {
    graph, source, repaired, parseOk, loadError, skippedResolvers,
  } = await loadShapeGraph(fileName, content);
  const diagnostics = !parseOk || loadError ? parseDiagnostics(content, source, loadError) : [];

  // canonical: varlock's generator output, keys verbatim-mapped
  let fields: Awaited<ReturnType<typeof resolveFields>> = [];
  try {
    fields = await resolveFields(graph);
  } catch {
    // reported through the supplemental
  }
  const src: string = await (graph.codeGeneratorsRegistry as any).generateTsTypes.generate({
    graph,
    fields,
    options: { exposeEnv: ctx.project.exposeEnv, icons: false },
    outputPath: path.join(path.dirname(fileName), ctx.project.exposeEnv === 'local' ? 'env.ts' : 'env.d.ts'),
    sourceDir: path.dirname(fileName),
  });
  const offsets = keyOffsets(source.parsedFile, repaired.text, repaired.toOrig);
  const b = new MappedCodeBuilder(content, { positionEncoding: ctx.positionEncoding });
  const mapKey = (key: string) => {
    const at = offsets.get(key);
    if (at === undefined) b.append(IDENT.test(key) ? key : JSON.stringify(key));
    else if (IDENT.test(key) && content.slice(at, at + key.length) === key) {
      b.appendVerbatim(at, at + key.length, KEY_F);
    } else b.appendAlias(IDENT.test(key) ? key : JSON.stringify(key), at, at + key.length, ALIAS_F);
  };
  let inSchema = false;
  for (const line of src.split('\n')) {
    if (line.startsWith('export type CoercedEnvSchema = {')) inSchema = true;
    else if (inSchema && line.startsWith('};')) inSchema = false;
    if (/Pick<.*'/.test(line)) {
      // 'KEY' literals in Pick<> are references too (rename must reach them)
      let last = 0;
      for (const mm of line.matchAll(/'([A-Za-z_][\w.-]*)'/g)) {
        const o = offsets.get(mm[1]);
        if (o === undefined || !IDENT.test(mm[1])) continue;
        b.append(line.slice(last, mm.index + 1));
        b.appendVerbatim(o, o + mm[1].length, F.Rename | F.References);
        last = mm.index + 1 + mm[1].length;
      }
      b.append(`${line.slice(last)}\n`);
      continue;
    }
    const m = inSchema ? /^(\s+)("?)([A-Za-z_][\w.-]*)\2(\??:)/.exec(line) : null;
    if (!m || offsets.get(m[3]) === undefined) {
      b.append(`${line}\n`);
      continue;
    }
    b.append(m[1]);
    mapKey(m[3]);
    b.append(`${line.slice(m[1].length + m[3].length + 2 * m[2].length)}\n`);
  }
  const canonical = b.build('.ts');

  // supplemental: generated schema API + lowering
  const api = await genSchemaApi(graph, { envUnion: envUnionOf(graph, source) });
  const { out: supplemental, stats } = lowerSchema({
    content,
    fileName,
    graph,
    source,
    repaired,
    api,
    positionEncoding: ctx.positionEncoding,
    importMode: ctx.project.importMode,
  });

  const ms = performance.now() - t0;
  // blockedNetwork stays in the line for older log readers: shape mode never downloads, so it is always []
  const logLine = `[varlock-mapper] pid=${process.pid} transform ${fileName} ${ms.toFixed(1)}ms parse=${parseOk} repairs=${repaired.inserts.length} stubbed=${JSON.stringify([...new Set(skippedResolvers)])} blockedNetwork=[] slices=${stats.verbatim} invalid=${stats.invalid}\n`;
  // the language server keeps mapper stderr; `tsc` drops it, so VARLOCK_MAPPER_LOG appends to a file too
  process.stderr.write(logLine);
  if (process.env.VARLOCK_MAPPER_LOG) fs.appendFileSync(process.env.VARLOCK_MAPPER_LOG, logLine);
  const dumpDir = process.env.VARLOCK_MAPPER_DUMP;
  if (dumpDir) dumpVirtualFiles(dumpDir, fileName, canonical.text, supplemental.text);
  return { ...canonical, diagnostics, supplemental: [supplemental] };
}

runContentMapper<MapperOptions, Project>({
  diagnosticSource: 'varlock',
  openProject(params) {
    const exposeEnv = params.options?.exposeEnv ?? 'global';
    // 'module' (import type of the imported schema) is only sound for exposeEnv=local, see lower.ts
    const importMode = params.options?.importMode ?? (exposeEnv === 'local' ? 'module' : 'keys');
    return { project: { exposeEnv, importMode } };
  },
  transform,
});
