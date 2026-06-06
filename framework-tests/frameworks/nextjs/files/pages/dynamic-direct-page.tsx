import { ENV } from 'varlock/env';

export default function HomePage() {
  return (
    <main>
      <h1>Varlock Framework Test - Next.js (direct dynamic)</h1>
      <p>Dynamic public: {ENV.PUBLIC_DYNAMIC_VAR}</p>
    </main>
  );
}
