import { ENV } from 'varlock/env';

// Deliberately leak a sensitive value at REQUEST time — getServerSideProps never
// runs during the build, so build-output scanning can't catch this. The runtime
// response scanner must prevent the secret from reaching the client, and the
// runtime console.log must come out redacted in the server logs.
export function getServerSideProps() {
  console.log('runtime-secret-log-test:', ENV.SENSITIVE_VAR);
  return {
    props: { leaked: ENV.SENSITIVE_VAR },
  };
}

export default function LeakySsrPage(props: { leaked: string }) {
  return (
    <main>
      <h1>Leaky SSR Page</h1>
      <p>Sensitive: {props.leaked}</p>
    </main>
  );
}
