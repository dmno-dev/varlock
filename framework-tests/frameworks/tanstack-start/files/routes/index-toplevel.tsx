/* eslint-disable no-use-before-define */
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { ENV } from 'varlock/env';
// Import from router — this module has top-level ENV access
// and is statically imported (not code-split).
import { getEnvCheckResult } from '../router';

const getServerEnvData = createServerFn({ method: 'GET' }).handler(() => {
  console.log('secret-log-test::', ENV.SECRET_KEY);
  // Use the top-level result from router.tsx
  const topLevel = getEnvCheckResult();
  return {
    public_var: ENV.PUBLIC_VAR,
    api_url: topLevel.apiUrl,
    has_sensitive: topLevel.hasSecret,
  };
});

function IndexPage() {
  const data = Route.useLoaderData();
  return (
    <div>
      <div id="env-data">
        {`public_var::${data.public_var}`}
        {`\napi_url::${data.api_url}`}
        {`\nhas_sensitive::${data.has_sensitive}`}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/')({
  loader: () => getServerEnvData(),
  component: IndexPage,
});
