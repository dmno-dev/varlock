'use client';

import { ENV } from 'varlock/env';

export default function ClientPage() {
  return (
    <main>
      <h1>Varlock Client Component Test</h1>
      <p>ENV next prefixed var: {ENV.NEXT_PUBLIC_VAR}</p>
      <p>ENV unprefixed var: {ENV.PUBLIC_VAR}</p>
      <p>ENV env specific var: {ENV.ENV_SPECIFIC_VAR}</p>
      <p>process.env next prefixed var: {process.env.NEXT_PUBLIC_VAR}</p>
    </main>
  );
}
