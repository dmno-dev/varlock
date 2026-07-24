import { ENV } from 'varlock/env';

document.getElementById('app')!.innerHTML = `
  <h1>Varlock Vite Test</h1>
  <p class="public-var">${ENV.PUBLIC_VAR}</p>
  <p class="dynamic-var">${ENV.PUBLIC_DYNAMIC_VAR}</p>
`;
