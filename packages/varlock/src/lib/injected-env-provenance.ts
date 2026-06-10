import type { SerializedEnvGraph } from '../env-graph';

const OVERRIDE_PROVENANCE_SOURCE = 'varlock';
const OVERRIDE_PROVENANCE_VERSION = 1;

export type OverrideProvenanceMetadata = {
  source: typeof OVERRIDE_PROVENANCE_SOURCE;
  version: typeof OVERRIDE_PROVENANCE_VERSION;
  overrideKeys: Array<string>;
};

type SerializedGraphWithRunMetadata = SerializedEnvGraph & {
  __varlockOverrideMeta?: OverrideProvenanceMetadata;
  /** Legacy field written by previous implementation in run.command.ts */
  __varlockRunMeta?: {
    source: 'varlock-run';
    version: 1;
    overrideKeys: Array<string>;
  };
};

function normalizeOverrideKeys(overrideKeys: Array<string>) {
  return [...new Set(overrideKeys.filter((k) => typeof k === 'string'))];
}

export function buildOverrideProvenanceMetadata(
  overrideKeys: Array<string>,
): OverrideProvenanceMetadata {
  return {
    source: OVERRIDE_PROVENANCE_SOURCE,
    version: OVERRIDE_PROVENANCE_VERSION,
    overrideKeys: normalizeOverrideKeys(overrideKeys),
  };
}

export function parseOverrideProvenanceMetadata(blob?: string): OverrideProvenanceMetadata | undefined {
  if (!blob) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object') return undefined;
  const parsedGraph = parsed as SerializedGraphWithRunMetadata;
  const metadata = parsedGraph.__varlockOverrideMeta ?? parsedGraph.__varlockRunMeta;
  if (!metadata || typeof metadata !== 'object') return undefined;
  if (metadata.source !== OVERRIDE_PROVENANCE_SOURCE && metadata.source !== 'varlock-run') return undefined;
  if (metadata.version !== OVERRIDE_PROVENANCE_VERSION) return undefined;
  if (!Array.isArray(metadata.overrideKeys)) return undefined;
  if (metadata.overrideKeys.some((k) => typeof k !== 'string')) return undefined;

  return {
    source: OVERRIDE_PROVENANCE_SOURCE,
    version: OVERRIDE_PROVENANCE_VERSION,
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
