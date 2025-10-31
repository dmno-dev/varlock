import type { VarlockPlugin } from '../env-graph/lib/plugins';
export type { Resolver } from '../env-graph/lib/resolver';

// we must inject our varlock code via the global scope
// because of how we dynamically import the plugin code
// otherwise we'd end up with duplicates and instanceof checks will fail
declare global {
  const plugin: VarlockPlugin;
}
