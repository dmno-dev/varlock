/*
  Executed with plain `node dist/ssr-undefined-entry.js` after an SSR build with
  ssrInjectMode=resolved-env, so the inlined varlock init runs and performs the
  process.env injection according to the blob's settings. Logs the three env
  surfaces so tests can assert how an unset schema item (UNSET_VAR=) appears on each.
*/
import { ENV } from 'varlock/env';

console.log(`unset-in-process-env::${'UNSET_VAR' in process.env}`);
console.log(`process-env-unset::${JSON.stringify(process.env.UNSET_VAR)}`);
console.log(`process-env-set::${process.env.PUBLIC_VAR}`);
// vite only exposes prefixed keys (plus its builtins) through import.meta.env,
// so an unprefixed schema key is absent here regardless of injection mode
console.log(`import-meta-env-unset::${JSON.stringify(import.meta.env.UNSET_VAR)}`);
// static (non-sensitive, non-dynamic) items are inlined at build time; an unset
// item inlines as the `undefined` literal in both modes
console.log(`env-proxy-unset::${String(ENV.UNSET_VAR)}`);
console.log('ssr-undefined-check-done');
