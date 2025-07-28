import { component$ } from '@builder.io/qwik';
import { routeLoader$, type DocumentHead } from '@builder.io/qwik-city';

import { ENV } from 'varlock/env';

// This function executes on the server
export const useServerData = routeLoader$(async (/* _requestEvent */) => {
  // can safely use sensitive config here
  // logs will be redacted
  console.log('logs on the server', ENV.SECRET_FOO);

  // this will trigger leak detection!
  // return 'from-server--'+ENV.SECRET_FOO;

  return 'from-server';
});

export default component$(() => {
  const serverData = useServerData();
  return (
    <>
      <h1>Hi 👋</h1>
      <div>
        <ul>
          <li>EreqV.PUBLIC_FOO: {ENV.PUBLIC_FOO}</li>
          <li>ENV.VITE_PUBLIC_FOO: {ENV.VITE_PUBLIC_FOO}</li>
          {/* <li>ENV.SECRET_FOO: {ENV.SECRET_FOO}</li> */}
          <li>ENV.APP_ENV: {ENV.APP_ENV}</li>
          <li>ENV.REQUIRED_ITEM: {ENV.REQUIRED_ITEM}</li>
          <li>ENV.ENV_SPECIFIC_ITEM: {ENV.ENV_SPECIFIC_ITEM}</li>
          <li>ENV.VITE_ENV_SPECIFIC_ITEM: {ENV.VITE_ENV_SPECIFIC_ITEM}</li>
        </ul>
      </div>

      <p>data from server: {serverData.value}</p>
    </>
  );
});

export const head: DocumentHead = {
  title: 'Welcome to Qwik',
  meta: [
    {
      name: 'description',
      content: 'Qwik site description',
    },
  ],
};
