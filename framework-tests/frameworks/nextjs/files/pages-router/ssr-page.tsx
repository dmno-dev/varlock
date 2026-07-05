import { ENV } from 'varlock/env';

// pages-router request-time data fetching — runs on the server for every request
export function getServerSideProps() {
  return {
    props: {
      envSpecificVar: ENV.ENV_SPECIFIC_VAR,
      hasSensitive: !!ENV.SENSITIVE_VAR,
    },
  };
}

export default function PagesRouterSsrPage(
  props: { envSpecificVar: string, hasSensitive: boolean },
) {
  return (
    <main>
      <h1>Varlock Pages Router SSR Page</h1>
      <p>Next prefixed var: {ENV.NEXT_PUBLIC_VAR}</p>
      <p>Unprefixed var: {ENV.PUBLIC_VAR}</p>
      <p>Env specific var (via getServerSideProps): {props.envSpecificVar}</p>
      <p>Has sensitive: {props.hasSensitive ? 'pages-ssr-sensitive-available' : 'X - not available'}</p>
    </main>
  );
}
