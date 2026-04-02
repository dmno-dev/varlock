import { ENV } from 'varlock/env';

document.getElementById('app')!.innerHTML = `
  <h1>Varlock Vite Test</h1>
  <p class="public-var">${ENV.PUBLIC_VAR}</p>
  <p class="api-url">${ENV.API_URL}</p>
  <p class="env-specific">${ENV.ENV_SPECIFIC_VAR}</p>
  <p class="hot-reload-marker">hot-reload-success</p>
`;
