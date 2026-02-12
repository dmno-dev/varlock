import { ENV } from 'varlock/env';

export default function Page() {
  // Access env vars - this should work with varlock integration
  const apiUrl = ENV.NEXT_PUBLIC_API_URL;
  const hasDbUrl = !!ENV.DATABASE_URL;

  return (
    <main>
      <h1>Varlock Smoke Test - Next.js</h1>
      <p>API URL: {apiUrl}</p>
      <p>Has Database URL: {hasDbUrl ? 'Yes' : 'No'}</p>
      <p id="test-status">✅ Build succeeded with varlock integration</p>
    </main>
  );
}
