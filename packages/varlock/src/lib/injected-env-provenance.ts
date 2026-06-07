import type { SerializedEnvGraph } from '../env-graph';

const RUN_INJECTION_SOURCE = 'varlock-run';
const RUN_INJECTION_VERSION = 1;

type RunInjectionMetadata = {
  source: typeof RUN_INJECTION_SOURCE;
  version: typeof RUN_INJECTION_VERSION;
  overrideKeys: Array<string>;
};

type SerializedGraphWithRunMetadata = SerializedEnvGraph & {
  __varlockRunMeta?: RunInjectionMetadata;
};

function normalizeOverrideKeys(overrideKeys: Array<string>) {
  return [...new Set(overrideKeys.filter((k) => typeof k === 'string'))];
}

export function buildRunInjectedEnvBlob(opts: {
  serializedGraph: SerializedEnvGraph;
  overrideKeys: Array<string>;
}) {
  const graphWithMeta: SerializedGraphWithRunMetadata = {
    ...opts.serializedGraph,
    __varlockRunMeta: {
      source: RUN_INJECTION_SOURCE,
      version: RUN_INJECTION_VERSION,
      overrideKeys: normalizeOverrideKeys(opts.overrideKeys),
    },
  };
  return JSON.stringify(graphWithMeta);
}

export function parseRunInjectionMetadata(blob?: string): RunInjectionMetadata | undefined {
  if (!blob) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object') return undefined;
  const metadata = (parsed as SerializedGraphWithRunMetadata).__varlockRunMeta;
  if (!metadata || typeof metadata !== 'object') return undefined;
  if (metadata.source !== RUN_INJECTION_SOURCE) return undefined;
  if (metadata.version !== RUN_INJECTION_VERSION) return undefined;
  if (!Array.isArray(metadata.overrideKeys)) return undefined;
  if (metadata.overrideKeys.some((k) => typeof k !== 'string')) return undefined;

  return {
    source: metadata.source,
    version: metadata.version,
    overrideKeys: normalizeOverrideKeys(metadata.overrideKeys),
  };
}

export function selectOverrideValuesFromEnv(
  env: Record<string, string | undefined>,
  overrideKeys: Array<string>,
) {
  const selected: Record<string, string | undefined> = {};
  for (const key of overrideKeys) {
    if (key in env) selected[key] = env[key];
  }
  return selected;
}

