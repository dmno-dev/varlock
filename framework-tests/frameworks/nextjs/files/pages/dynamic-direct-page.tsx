import { ENV } from 'varlock/env';
import { DynamicClientWidget } from './components/dynamic-client-widget';

export default function HomePage() {
  return (
    <main>
      <h1>Varlock Framework Test - Next.js (direct dynamic)</h1>
      <p>Dynamic public: {ENV.PUBLIC_DYNAMIC_VAR}</p>
      <DynamicClientWidget />
    </main>
  );
}
