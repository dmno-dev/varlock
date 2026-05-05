/* eslint-disable no-use-before-define */
import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { ENV } from 'varlock/env';

const getServerEnvData = createServerFn({ method: 'GET' }).handler(() => {
  // Log a sensitive value to test console redaction
  console.log('secret-log-test::', ENV.SECRET_KEY);
  return {
    public_var: ENV.PUBLIC_VAR,
    api_url: ENV.API_URL,
    has_sensitive: ENV.SECRET_KEY ? 'yes' : 'no',
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
