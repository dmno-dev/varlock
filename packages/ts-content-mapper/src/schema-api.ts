// genSchemaApi(graph): a TypeScript API for the schema language, generated at transform time from the LIVE
// EnvGraph registries (built-ins plus whatever @plugin(...) registered). Nothing here is hand-written per
// decorator, resolver or type: names, docs and arity come from the registries' own metadata.
//   - data types: graph.dataTypesRegistry -> typeDescription, coercedType, docs. Settings keys are not declared
//     anywhere at runtime, so they are TRACED: each factory is called with a recording Proxy and its
//     coerce()/validate() are run on sample inputs
//   - resolvers: graph.registeredResolverFunctions -> def.description ?? def.label, argsSchema
//     (arrayExactLength/Min/Max, type array|object|mixed), inferredType
//   - item / root decorators: graph.itemDecoratorsRegistry / rootDecoratorsRegistry -> description, deprecated,
//     isFunction, incompatibleWith

const IDENT = /^[A-Za-z_$][\w$]*$/;
const prop = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
const IGNORED_KEYS = new Set([
  'then',
  'toJSON',
  'constructor',
  'length',
  '__proto__',
  'valueOf',
  'toString',
  'prototype',
  'asymmetricMatch',
  'nodeType',
  '$$typeof',
  'inspect',
]);
const SAMPLES = [
  '1',
  '42',
  'abc',
  'Abc-1',
  'https://example.com/x',
  'example.com',
  'a@b.co',
  '127.0.0.1',
  '1.2.3',
  '2020-01-01',
  '00000000-0000-4000-8000-000000000000',
  'd41d8cd98f00b204e9800998ecf8427e',
  '1h',
  'true',
  '[1,2]',
  '{"a":1}',
  'a,b',
  '*.example.com',
];

const jsdocEscape = (s: unknown) => String(s).replace(/\*\//g, '*\\/');
function jsdoc(lines: Array<unknown>, indent = '  ') {
  const ls = lines
    .filter((l) => l !== undefined && l !== null && l !== '')
    .flatMap((l) => String(l).split('\n'));
  if (!ls.length) return '';
  return `${indent}/**\n${ls.map((l) => `${indent} * ${jsdocEscape(l)}`).join('\n')}\n${indent} */\n`;
}

export async function traceSettingsKeys(factory: (settings?: any) => any) {
  const keys = new Set<string>();
  const rec = (k: string | symbol) => {
    if (typeof k === 'string' && !IGNORED_KEYS.has(k)) keys.add(k);
  };
  const proxy = new Proxy({}, {
    get(_t, k) {
      rec(k);
      return undefined;
    },
    has(_t, k) {
      rec(k);
      return false;
    },
  });
  let def: any;
  try {
    def = factory(proxy)?._rawDef;
  } catch {
    // factory rejected the proxy
  }
  for (const s of SAMPLES) {
    if (!def) break;
    try {
      const c = def.coerce ? def.coerce(s) : s;
      if (c instanceof Error) continue;
      const r = def.validate?.(c);
      if (r && typeof r.then === 'function') await r.catch(() => undefined);
    } catch {
      // invalid sample
    }
  }
  return [...keys];
}

function coercedToTs(ct: any): string {
  if (ct === undefined) return 'string';
  if (ct === 'int' || ct === 'number') return 'number';
  if (ct === 'boolean') return 'boolean';
  if (ct === 'object') return 'Record<string, unknown>';
  if (typeof ct === 'object' && ct && 'enum' in ct) return 'string';
  if (typeof ct === 'object' && ct && 'arrayOf' in ct) return `Array<${coercedToTs(ct.arrayOf)}>`;
  return 'unknown';
}
const coercedLabel = (ct: unknown) => {
  if (ct === undefined) return 'string';
  return typeof ct === 'string' ? ct : JSON.stringify(ct);
};

function resolverParams(name: string, def: any, envUnion: string) {
  if (name === 'forEnv') return `...envs: Array<${envUnion}>`;
  const s = def.argsSchema;
  if (!s) return '...args: VarlockValue[]';
  if (s.type === 'object') return 'options: VarlockOptions';
  const min = s.arrayExactLength ?? s.arrayMinLength ?? 0;
  const max = s.arrayExactLength ?? s.arrayMaxLength;
  const ps: Array<string> = [];
  for (let i = 0; i < min; i++) ps.push(`arg${i + 1}: VarlockValue`);
  if (max !== undefined) {
    for (let i = min; i < max; i++) ps.push(`arg${i + 1}?: VarlockValue`);
    if (s.type === 'mixed') ps.push('options?: VarlockOptions');
  } else {
    ps.push('...rest: VarlockValue[]');
  }
  return ps.join(', ');
}

type CatalogEntry = { name: string, plugin?: string, settings?: Array<string>, documented?: boolean };
type Namespace = 'types' | 'fns' | 'dec' | 'root';

/** returns { text, catalog } where catalog lists every emitted name per namespace with its origin */
export async function genSchemaApi(graph: any, { envUnion = 'string' } = {}) {
  const origin = new Map<string, string>(); // `${ns}:${name}` -> plugin name
  for (const p of graph.plugins ?? []) {
    for (const d of p.dataTypes ?? []) origin.set(`types:${d.name ?? d().name}`, p.name);
    for (const d of p.resolverFunctions ?? []) origin.set(`fns:${d.name}`, p.name);
    for (const d of p.itemDecorators ?? []) origin.set(`dec:${d.name}`, p.name);
    for (const d of p.rootDecorators ?? []) origin.set(`root:${d.name}`, p.name);
    for (const d of p.codeGenerators ?? []) origin.set(`root:${d.decoratorName}`, p.name);
  }
  const catalog: Record<Namespace, Array<CatalogEntry>> = {
    types: [], fns: [], dec: [], root: [],
  };
  const from = (ns: Namespace, name: string) => {
    const o = origin.get(`${ns}:${name}`);
    catalog[ns].push({ name, plugin: o });
    return o ? `from plugin \`${o}\`` : '';
  };
  let t = '// ---- schema API generated from the live EnvGraph registries ----\n';
  t += 'type VarlockValue = unknown;\ntype VarlockOptions = { [option: string]: VarlockValue };\n';
  t += 'type VarlockType<Name extends string, Coerced> = { readonly __dataType: Name; readonly __coerced?: Coerced };\n';
  t += `type VarlockEnv = ${envUnion};\n`;
  t += 'declare function __invalid(problem: never): void;\n';

  // data types
  t += '/** varlock data types (`@type=...`), from `EnvGraph.dataTypesRegistry` */\ninterface VarlockDataTypes {\n';
  for (const [name, factory] of Object.entries<any>(graph.dataTypesRegistry)) {
    let def: any = {};
    try {
      def = factory()._rawDef ?? {};
    } catch {
      // needs args
    }
    const keys = name === 'enum' ? [] : await traceSettingsKeys(factory);
    const docs = (def.docs ?? []).map((d: any) => (typeof d === 'string' ? d : `[${d.description}](${d.url})`));
    t += jsdoc([
      `**@type=${name}**${def.typeDescription ? ` - ${def.typeDescription}` : ''}`,
      `coerces to \`${coercedLabel(def.coercedType)}\``,
      def.sensitive ? 'marks items sensitive' : '',
      def.internal ? 'marks items internal' : '',
      ...docs,
      from('types', name),
    ]);
    let params = '';
    if (name === 'enum') params = '...options: Array<string | number | boolean>';
    else if (keys.length) params = `settings?: { ${keys.map((k) => `${prop(k)}?: VarlockValue`).join('; ')} }`;
    t += `  ${prop(name)}(${params}): VarlockType<${JSON.stringify(name)}, ${coercedToTs(def.coercedType)}>;\n`;
    const entry = catalog.types.at(-1)!;
    entry.settings = keys;
    entry.documented = !!def.typeDescription;
  }
  t += '}\ndeclare const __types: VarlockDataTypes;\n';

  // resolver functions
  t += '/** varlock resolver functions, from `EnvGraph.registeredResolverFunctions` */\ninterface VarlockResolvers {\n';
  for (const [name, Cls] of Object.entries<any>(graph.registeredResolverFunctions)) {
    const def = Cls.def ?? {};
    const inferredDt = def.inferredType && graph.dataTypesRegistry[def.inferredType];
    let ret = 'unknown';
    if (def.inferredType) ret = inferredDt ? coercedToTs(inferredDt().coercedType) : coercedToTs(def.inferredType);
    const s = def.argsSchema;
    const arity = s ? [
      s.arrayExactLength !== undefined ? `exactly ${s.arrayExactLength}` : '',
      s.arrayMinLength !== undefined ? `min ${s.arrayMinLength}` : '',
      s.arrayMaxLength !== undefined ? `max ${s.arrayMaxLength}` : '',
    ].filter(Boolean).join(', ') : '';
    const summary = def.description ?? def.label;
    t += jsdoc([
      `**${name}()**${summary ? ` - ${summary}` : ''}`,
      def.inferredType ? `infers \`@type=${def.inferredType}\`` : '',
      def.impliesSensitive ? 'implies `@sensitive`' : '',
      s ? `args: ${s.type}${arity ? ` (${arity})` : ''}` : '',
      from('fns', name),
    ]);
    t += `  ${prop(name)}(${resolverParams(name, def, 'VarlockEnv')}): ${ret};\n`;
    catalog.fns.at(-1)!.documented = !!summary;
  }
  t += '}\ndeclare const __fns: VarlockResolvers;\n';

  const decBlock = (ns: Namespace, iface: string, registry: Record<string, any>, title: string) => {
    let s = `/** ${title} */\ninterface ${iface} {\n`;
    for (const [name, def] of Object.entries(registry)) {
      s += jsdoc([
        `**@${name}**${def.description ? ` - ${def.description}` : ''}`,
        def.isFunction ? `function form: \`@${name}(...)\`` : '',
        def.incompatibleWith?.length ? `incompatible with ${def.incompatibleWith.map((x: string) => `@${x}`).join(', ')}` : '',
        def.deprecated ? `@deprecated ${def.deprecated === true ? '' : def.deprecated}` : '',
        from(ns, name),
      ]);
      let params = 'value?: VarlockValue';
      if (name === 'type') params = 'spec: VarlockType<string, unknown>';
      else if (def.isFunction || def.isFunctionOrValue || def.useFnArgsResolver) params = '...args: VarlockValue[]';
      s += `  ${prop(name)}(${params}): void;\n`;
      catalog[ns].at(-1)!.documented = !!def.description;
    }
    return `${s}}\n`;
  };
  t += decBlock('dec', 'VarlockItemDecorators', graph.itemDecoratorsRegistry, 'item decorators, from `EnvGraph.itemDecoratorsRegistry`');
  t += 'declare const __dec: VarlockItemDecorators;\n';
  t += decBlock('root', 'VarlockRootDecorators', graph.rootDecoratorsRegistry, 'root decorators, from `EnvGraph.rootDecoratorsRegistry` (incl. code generators)');
  t += 'declare const __root: VarlockRootDecorators;\n';
  return { text: t, catalog };
}
