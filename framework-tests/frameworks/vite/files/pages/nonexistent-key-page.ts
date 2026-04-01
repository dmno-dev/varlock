import { ENV } from 'varlock/env';

document.getElementById('app')!.innerHTML = `
  <h1>Varlock Vite Test</h1>
  <p class="public-var">${ENV.PUBLIC_VAR}</p>
  <p class="bad-key">${(ENV as any).DOES_NOT_EXIST}</p>
`;
