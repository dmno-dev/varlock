'use client';

import { ENV } from 'varlock/env';

export default function ClientPage() {
  // sensitive vars can be referenced from client code without breaking the
  // build — the value just must not appear in any client-visible output
  const hasSensitive = !!ENV.SENSITIVE_VAR;

  // ENV references inside string literals and template literal text must be
  // rendered verbatim — static inlining only rewrites real member expressions
  const envRefInString = 'ENV.PUBLIC_VAR mentioned in a string';
  const envRefInTemplate = `ENV.PUBLIC_VAR in template text, interpolated: ${ENV.PUBLIC_VAR}`;

  return (
    <main>
      <h1>Varlock Client Component Page</h1>
      <p>Next prefixed var: {ENV.NEXT_PUBLIC_VAR}</p>
      <p>Unprefixed var: {ENV.PUBLIC_VAR}</p>
      <p>Env specific var: {ENV.ENV_SPECIFIC_VAR}</p>
      <p>Has sensitive: {hasSensitive ? 'yes' : 'no'}</p>
      <p>String ref: {envRefInString}</p>
      <p>Template ref: {envRefInTemplate}</p>
    </main>
  );
}
