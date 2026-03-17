import { ENV } from 'varlock/env';

export default function Page() {
  // Deliberately render a sensitive value — this should cause the build to fail
  return (
    <main>
      <h1>Leaky Page</h1>
      <p>Sensitive: {ENV.SENSITIVE_VAR}</p>
    </main>
  );
}
