import { define } from 'gunshi';

import { commandSpec as codegenCommandSpec, commandFn as codegenCommandFn } from './codegen.command';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';

// Deprecated alias for `varlock codegen` — kept for back-compat. Same behavior, just warns.
export const commandSpec = define({
  name: 'typegen',
  description: '(deprecated) alias for `varlock codegen`',
  args: codegenCommandSpec.args,
  examples: 'Deprecated alias for `varlock codegen` — kept for back-compat. Use `varlock codegen` instead.',
  // hide from `varlock help` — still runnable, but we only advertise `codegen`
  internal: true,
});

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  console.warn('[varlock] ⚠️  `varlock typegen` is deprecated — use `varlock codegen` instead.');
  return codegenCommandFn(ctx as any);
};
