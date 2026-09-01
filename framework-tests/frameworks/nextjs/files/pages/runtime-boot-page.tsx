import { ENV } from 'varlock/env';

// force runtime rendering so the page reflects boot-time env values
export const dynamic = 'force-dynamic';

export default function RuntimeBootPage() {
  return (
    <main>
      <h1>Varlock Framework Test - runtime boot</h1>
      <p>{`runtime var via ENV: ${ENV.RUNTIME_BOOT_VAR}`}</p>
      <p>{`runtime var via process.env: ${process.env.RUNTIME_BOOT_VAR}`}</p>
    </main>
  );
}
