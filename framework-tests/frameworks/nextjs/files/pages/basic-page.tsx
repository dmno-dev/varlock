import { ENV } from 'varlock/env';

export default function Page() {
  const hasSensitive = !!ENV.SENSITIVE_VAR;

  // we'll check that the sensitive var is redacted
  console.log('secret-log-test:', ENV.SENSITIVE_VAR);

  return (
    <main>
      <h1>Varlock Framework Test - Next.js</h1>
      <p>Next prefixed var: {ENV.NEXT_PUBLIC_VAR}</p>
      <p>Unprefixed var: {ENV.PUBLIC_VAR}</p>
      <p>Env specific var: {ENV.ENV_SPECIFIC_VAR}</p>
      <p>Has sensitive: {hasSensitive ? 'sensitive-var-available' : 'X - not available'}</p>
    </main>
  );
}
