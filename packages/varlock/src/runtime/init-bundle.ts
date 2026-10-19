// Self-contained init bundle: the `varlock/auto-init` sequence as a single CJS file (built
// with noExternal, see tsdown.config.ts) so framework integrations can inject it as raw JS
// into bundler output, or import it from a copied location, where chunk requires would not
// resolve. One bundle serves every runtime: the sequence is edge-safe, node builtins are
// loaded lazily and the patches that need them become no-ops where they are missing.
export * from './auto-init';
