import { BaseDataTypes, isCompositeCoercedType, type EnvGraphDataType } from '../env-graph/lib/data-types';
import type { SerializedEnvGraph } from '../env-graph';

/**
 * `@dynamic=boot` items in a frozen env.
 *
 * A boot item is frozen like everything else - its freeze-time value is the default - but the
 * environment at boot may override it. The override is checked against what `varlock freeze`
 * recorded about the item (its type and whether it is required), using the same built-in data
 * type implementations the schema uses, rebuilt from the recorded settings. So every consumer
 * (auto-load, `varlock run`, `varlock load`) can apply it in-process: a frozen env never needs
 * the varlock CLI or a schema at runtime.
 *
 * Kept free of the graph engine (data-types loads on its own) because auto-load imports it.
 */

/** What a frozen env records about one `@dynamic=boot` item */
export type FrozenBootKey = {
  /** built-in data type name, e.g. `port` */
  type: string,
  /** the settings the type was created with, e.g. `[{ min: 1 }]`, when there are any */
  typeArgs?: Array<any>,
  /** whether a value is required (resolved at freeze time, so `forEnv(...)` etc. are fine) */
  required: boolean,
};

type EnvRecord = Record<string, string | undefined>;

/** whether a value survives JSON intact - plain data only (a RegExp would become `{}`) */
function isPlainJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  // an omitted/undefined setting reads the same as null through `settings?.x`
  if (Array.isArray(value)) return value.every((v) => v === undefined || isPlainJson(v));
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    // an undefined setting is the same as an absent one, which is what JSON produces
    return Object.values(value).every((v) => v === undefined || isPlainJson(v));
  }
  return false;
}

/**
 * Why a data type cannot be recorded for a `@dynamic=boot` item, or undefined when it can.
 * Checked on every schema load, so a schema is equally valid whether or not it is ever frozen.
 */
export function getBootDataTypeProblem(
  dataType: EnvGraphDataType | undefined,
  opts: { hasComputedType: boolean },
): string | undefined {
  if (!dataType) return undefined;
  if (opts.hasComputedType) return 'its @type is computed';
  if (!BaseDataTypes.includes(dataType._factory)) return `type "${dataType.name}" is not a built-in type`;
  if (isCompositeCoercedType(dataType.coercedType)) return `type "${dataType.name}" is a composite type`;
  if (!isPlainJson(dataType.usageArgs)) return `the settings of type "${dataType.name}" cannot be recorded`;
  return undefined;
}

/** The record for one `@dynamic=boot` item (its type must have passed getBootDataTypeProblem) */
export function describeFrozenBootKey(dataType: EnvGraphDataType | undefined, required: boolean): FrozenBootKey {
  const args = [...(dataType?.usageArgs ?? [])];
  while (args.length && args[args.length - 1] === undefined) args.pop();
  const typeArgs = args.length ? args : undefined;
  return {
    type: dataType?.name ?? 'string',
    ...(typeArgs ? { typeArgs } : {}),
    required,
  };
}

/** The `@dynamic=boot` items a frozen env records, if any */
export function getFrozenBootKeys(graph: SerializedEnvGraph): Record<string, FrozenBootKey> {
  const boot = graph.frozen?.boot;
  return boot && typeof boot === 'object' ? boot : {};
}

function errorMessages(result: unknown): Array<string> {
  const errs = Array.isArray(result) ? result : [result];
  return errs.filter((e) => e instanceof Error).map((e) => e.message);
}

/**
 * Apply boot-time values for a frozen env's `@dynamic=boot` items, same as a process.env
 * override in a normal load: a key present in `env` (even empty) replaces the frozen value
 * after coercion and validation, a key absent keeps it. Every other item stays frozen.
 *
 * Returns a new graph (the input is not modified) plus one problem per item that failed; the
 * caller decides how to fail. Use the pre-injection env, so a value varlock itself injected
 * earlier in this process cannot pose as a boot-time override.
 */
export function applyFrozenBootKeys(
  graph: SerializedEnvGraph,
  env: EnvRecord,
): { graph: SerializedEnvGraph, problems: Array<string> } {
  const bootKeys = getFrozenBootKeys(graph);
  const problems: Array<string> = [];
  const config = { ...graph.config };

  for (const [key, spec] of Object.entries(bootKeys)) {
    const item = config[key];
    // a boot key always has a config entry (its frozen default, even if undefined); without
    // one there is no sensitivity to go on, so never let the env introduce it
    if (!item) continue;
    if (!(key in env)) {
      if (spec.required && item.value === undefined) {
        problems.push(`${key} is required, but it is not set at boot and has no frozen default`);
      }
      continue;
    }

    const raw = env[key] as string;
    const { overrideStr: _staleOverrideStr, ...rest } = item;
    if (raw === '') {
      config[key] = { ...rest, value: '' };
      if (spec.required) problems.push(`${key} is required, but it is set to an empty value at boot`);
      continue;
    }

    const factory = BaseDataTypes.find((f) => f.dataTypeName === spec.type);
    if (!factory) {
      problems.push(`${key} has type "${spec.type}", which this version of varlock does not know - re-freeze with the same varlock version`);
      continue;
    }
    const dataType = factory(...(spec.typeArgs ?? []));

    let value: any;
    try {
      value = dataType.coerce(raw);
      if (value instanceof Error) throw value;
    } catch (err) {
      problems.push(`${key}: ${(err as Error).message}`);
      continue;
    }
    if (value === undefined) {
      config[key] = { ...rest, value: undefined };
      if (spec.required) problems.push(`${key} is required, but its boot value is empty`);
      continue;
    }

    let result: unknown;
    try {
      result = dataType.validate(value);
    } catch (err) {
      result = err;
    }
    if (result && typeof (result as any).then === 'function') {
      problems.push(`${key}: type "${spec.type}" cannot be checked at boot`);
      continue;
    }
    const messages = result === false ? ['validation failed'] : errorMessages(result);
    if (messages.length) {
      problems.push(...messages.map((m) => `${key}: ${m}`));
      continue;
    }

    // keep the raw string as provenance when it differs from the injected form, so an
    // ambient echo of it is recognised later (non-sensitive only, like the serializer)
    const injected = dataType.serialize(value);
    config[key] = {
      ...rest,
      value,
      ...(!item.isSensitive && raw !== injected ? { overrideStr: raw } : {}),
    };
  }

  return { graph: { ...graph, config }, problems };
}
