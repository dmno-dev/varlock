
// ! re-exporting types from @env-spec/env-graph (which we are bundling into this package) causes problems
// the dts generation step does not respect the noExternal option as it does for the actual code
// so instead we will redefine it here

// import { type SerializedEnvGraph } from '@env-spec/env-graph';

export type SerializedEnvGraph = {
  basePath?: string,
  sources: Array<{
    label: string;
    enabled: boolean;
    path?: string;
  }>,
  settings: {
    redactLogs?: boolean;
    preventLeaks?: boolean;
  },
  config: Record<string, {
    value: any;
    isSensitive: boolean;
  }>;
};
