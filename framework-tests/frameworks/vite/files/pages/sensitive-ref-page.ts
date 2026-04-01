import { ENV } from 'varlock/env';

const hasSensitive = !!ENV.SECRET_KEY;

document.getElementById('app')!.innerHTML = `
  <h1>Varlock Vite Test</h1>
  <p class="public-var">${ENV.PUBLIC_VAR}</p>
  <p class="has-sensitive">${hasSensitive ? 'sensitive-var-available' : 'not-available'}</p>
`;
