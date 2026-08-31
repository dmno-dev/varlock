import { define } from 'gunshi';

import { commandSpec as codegenCommandSpec } from './codegen.command-spec';

// Deprecated alias for `varlock codegen` — kept for back-compat. Same behavior, just warns.
export const commandSpec = define({
  name: 'typegen',
  description: '(deprecated) alias for `varlock codegen`',
  args: codegenCommandSpec.args,
  examples: 'Deprecated alias for `varlock codegen` — kept for back-compat. Use `varlock codegen` instead.',
  // hide from `varlock help` — still runnable, but we only advertise `codegen`
  internal: true,
});
