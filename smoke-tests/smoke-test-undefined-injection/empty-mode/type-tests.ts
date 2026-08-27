/*
  Not executed — typechecked against the generated env.d.ts by
  tests/undefined-injection.test.ts (tsc --strict). Empty mode
  (@injectUndefinedAsEmpty): every key is present on process.env, with ''
  added to the unions of keys that can be unset — but import.meta.env keeps
  its optional keys, since frameworks only expose prefixed keys through it.

  Uses the REAL `process` global from @types/node (no local shadow), so the
  always-present schema keys must survive declaration merging with
  @types/node's ProcessEnv index signature (`string | undefined`).
*/
/// <reference types="node" />
declare const importMetaEnv: ImportMetaEnv;

// process.env keys are always present; optional enums/booleans gain '' in their union.
// crucially these hold against the REAL merged ProcessEnv — the named schema props
// win over @types/node's index signature for named lookups
const mode: 'alpha' | 'beta' | '' = process.env.MODE_VAR;
const flag: 'true' | 'false' | '' = process.env.FLAG_VAR;
const unsetStr: string = process.env.UNSET_VAR;

// @ts-expect-error 'gamma' is still rejected — the enum union is preserved, not widened
const badMode: typeof process.env.MODE_VAR = 'gamma';

// required items keep their exact unions — '' is only added to keys that can be unset
const reqMode: 'alpha' | 'beta' = process.env.REQ_MODE_VAR;

// @ts-expect-error '' must not leak into a required enum union
const reqModeEmpty: typeof process.env.REQ_MODE_VAR = '';

// non-schema keys still flow through @types/node's index signature, unaffected by the mode
const path: string | undefined = process.env.PATH;

// @ts-expect-error the injection guarantee covers schema keys only — index-signature
// keys stay possibly-undefined
const randomKey: string = process.env.SOME_RANDOM_NON_SCHEMA_VAR;

// import.meta.env is NOT covered by the injection guarantee — keys stay optional
const metaMode: 'alpha' | 'beta' | undefined = importMetaEnv.MODE_VAR;

// @ts-expect-error import.meta.env keys may be absent regardless of injection mode
const metaUnset: string = importMetaEnv.UNSET_VAR;

// @ts-expect-error '' is not in the import.meta.env union
const metaEmpty: typeof importMetaEnv.MODE_VAR = '';

export {
  mode, flag, unsetStr, badMode, reqMode, reqModeEmpty, path, randomKey,
  metaMode, metaUnset, metaEmpty,
};
