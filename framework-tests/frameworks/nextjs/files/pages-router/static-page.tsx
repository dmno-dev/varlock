import { ENV } from 'varlock/env';

// pages-router build-time data fetching — runs in the prerender worker
export function getStaticProps() {
  // we'll check that the sensitive var is redacted
  console.log('pages-static-secret-log-test:', ENV.SENSITIVE_VAR);
  return {
    props: {
      envSpecificVar: ENV.ENV_SPECIFIC_VAR,
      hasSensitive: !!ENV.SENSITIVE_VAR,
    },
  };
}

export default function PagesRouterStaticPage(
  props: { envSpecificVar: string, hasSensitive: boolean },
) {
  return (
    <main>
      <h1>Varlock Pages Router Static Page</h1>
      <p>Next prefixed var: {ENV.NEXT_PUBLIC_VAR}</p>
      <p>Unprefixed var: {ENV.PUBLIC_VAR}</p>
      <p>Env specific var (via getStaticProps): {props.envSpecificVar}</p>
      <p>Has sensitive: {props.hasSensitive ? 'pages-static-sensitive-available' : 'X - not available'}</p>
    </main>
  );
}
