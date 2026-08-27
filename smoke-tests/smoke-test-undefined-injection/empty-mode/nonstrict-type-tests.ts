/*
  Not executed — typechecked against the generated env.d.ts by
  tests/undefined-injection.test.ts with tsc and strictNullChecks DISABLED.
  Optionality in the generated types is detected structurally, so required
  literal unions must stay exact even without strict null checks (where
  `undefined extends T` would be true for every type).
*/
declare const process: { env: NodeJS.ProcessEnv };

// required enum keeps its exact union
const reqMode: 'alpha' | 'beta' = process.env.REQ_MODE_VAR;

// @ts-expect-error '' must not leak into a required enum union without strictNullChecks
const reqModeEmpty: typeof process.env.REQ_MODE_VAR = '';

// @ts-expect-error 'gamma' is still rejected
const reqModeBad: typeof process.env.REQ_MODE_VAR = 'gamma';

// optional enum/boolean still gain '' in empty mode
const optMode: 'alpha' | 'beta' | '' = process.env.MODE_VAR;
const optModeEmpty: typeof process.env.MODE_VAR = '';
const optFlag: 'true' | 'false' | '' = process.env.FLAG_VAR;

export {
  reqMode, reqModeEmpty, reqModeBad, optMode, optModeEmpty, optFlag,
};
