'use client';

import { ENV } from 'varlock/env';

export default function LeakyClientPage() {
  // Deliberately render a sensitive value — this should cause the build to fail
  return (
    <main>
      <h1>Leaky Client Page</h1>
      <p>Sensitive: {ENV.SENSITIVE_VAR}</p>
    </main>
  );
}
