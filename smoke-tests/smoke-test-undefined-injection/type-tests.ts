/*
  Not executed — typechecked against the generated env.d.ts by
  tests/undefined-injection.test.ts (tsc --strict). Default (skip) mode:
  unset items are left off process.env, so its keys stay optional.

  Uses the REAL `process` global from @types/node (no local shadow), so these
  assertions also exercise declaration merging between the generated ProcessEnv
  augmentation and @types/node's own ProcessEnv (index signature + built-ins).
*/
/// <reference types="node" />
declare const importMetaEnv: ImportMetaEnv;

// optional enums keep their literal unions (plus undefined) on both surfaces
const mode: 'alpha' | 'beta' | undefined = process.env.MODE_VAR;
const metaMode: 'alpha' | 'beta' | undefined = importMetaEnv.MODE_VAR;

// @ts-expect-error unset items may be absent from process.env
const unsetStr: string = process.env.UNSET_VAR;

// @ts-expect-error '' is not in the union — unset items are skipped, not injected as ''
const emptyMode: typeof process.env.MODE_VAR = '';

// set items are still plain strings once narrowed
const setVar: string | undefined = process.env.SET_VAR;

// optional booleans keep their literal union (plus undefined)
const flag: 'true' | 'false' | undefined = process.env.FLAG_VAR;

// required items are non-optional even in skip mode (they can never be unset)
const reqMode: 'alpha' | 'beta' = process.env.REQ_MODE_VAR;

// non-schema keys still flow through @types/node's index signature
const path: string | undefined = process.env.PATH;

// @ts-expect-error index-signature keys stay possibly-undefined
const randomKey: string = process.env.SOME_RANDOM_NON_SCHEMA_VAR;

export {
  mode, metaMode, unsetStr, emptyMode, setVar, flag, reqMode, path, randomKey,
};
