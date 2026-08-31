import packageJson from '../../package.json';

/**
 * Version of this varlock package, baked into builds at bundle time.
 *
 * Used to stamp serialized `__VARLOCK_ENV` blobs with their producer version and to detect
 * skew on the consumer side. Producers and consumers can legitimately be different builds:
 * a parent `varlock run` vs a child process's varlock dependency, a global CLI vs a local
 * package, or runtime code bundled into an integration (e.g. the nextjs @next/env
 * replacement) vs the installed varlock that resolved the env.
 */
export const VARLOCK_VERSION: string = packageJson.version;
