/*
  Not executed — typechecked against the generated env.d.ts by
  tests/undefined-injection.test.ts (tsc --strict). Empty mode
  (@injectUndefinedAsEmpty): every key is present on process.env, with ''
  added to the unions of keys that can be unset — but import.meta.env keeps
  its optional keys, since frameworks only expose prefixed keys through it.
*/
declare const process: { env: NodeJS.ProcessEnv };
declare const importMetaEnv: ImportMetaEnv;

// process.env keys are always present; optional enums/booleans gain '' in their union
const mode: 'alpha' | 'beta' | '' = process.env.MODE_VAR;
const flag: 'true' | 'false' | '' = process.env.FLAG_VAR;
const unsetStr: string = process.env.UNSET_VAR;

// @ts-expect-error 'gamma' is still rejected — the enum union is preserved, not widened
const badMode: typeof process.env.MODE_VAR = 'gamma';

// required items keep their exact unions — '' is only added to keys that can be unset
const reqMode: 'alpha' | 'beta' = process.env.REQ_MODE_VAR;

// @ts-expect-error '' must not leak into a required enum union
const reqModeEmpty: typeof process.env.REQ_MODE_VAR = '';

// import.meta.env is NOT covered by the injection guarantee — keys stay optional
const metaMode: 'alpha' | 'beta' | undefined = importMetaEnv.MODE_VAR;

// @ts-expect-error import.meta.env keys may be absent regardless of injection mode
const metaUnset: string = importMetaEnv.UNSET_VAR;

// @ts-expect-error '' is not in the import.meta.env union
const metaEmpty: typeof importMetaEnv.MODE_VAR = '';

export {
  mode, flag, unsetStr, badMode, reqMode, reqModeEmpty, metaMode, metaUnset, metaEmpty,
};
