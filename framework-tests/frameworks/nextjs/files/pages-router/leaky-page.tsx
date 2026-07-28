import { ENV } from 'varlock/env';

// Deliberately pass a sensitive value through getStaticProps — it ends up in
// both the rendered HTML and the __NEXT_DATA__ payload, so the build must fail
export function getStaticProps() {
  return {
    props: { leakedSecret: ENV.SENSITIVE_VAR },
  };
}

export default function LeakyPagesRouterPage(props: { leakedSecret: string }) {
  return (
    <main>
      <h1>Leaky Pages Router Page</h1>
      <p>Sensitive: {props.leakedSecret}</p>
    </main>
  );
}
