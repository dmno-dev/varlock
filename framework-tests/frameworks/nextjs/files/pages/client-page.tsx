'use client';

import { ENV } from 'varlock/env';

export default function ClientPage() {
  // sensitive vars can be referenced from client code without breaking the
  // build — the value just must not appear in any client-visible output
  const hasSensitive = !!ENV.SENSITIVE_VAR;

  return (
    <main>
      <h1>Varlock Client Component Page</h1>
      <p>Next prefixed var: {ENV.NEXT_PUBLIC_VAR}</p>
      <p>Unprefixed var: {ENV.PUBLIC_VAR}</p>
      <p>Env specific var: {ENV.ENV_SPECIFIC_VAR}</p>
      <p>Has sensitive: {hasSensitive ? 'yes' : 'no'}</p>
    </main>
  );
}
