'use client';

import { ENV } from 'varlock/env';

export default function ClientPage() {
  return (
    <main>
      <h1>Varlock Client Component Test</h1>
      <p>Next prefixed var: {ENV.NEXT_PUBLIC_VAR}</p>
      <p>Unprefixed var: {ENV.PUBLIC_VAR}</p>
      <p>Env specific var: {ENV.ENV_SPECIFIC_VAR}</p>
    </main>
  );
}
