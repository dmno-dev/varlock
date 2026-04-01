import { ENV } from 'varlock/env';

export function render() {
  const hasSensitive = !!ENV.SECRET_KEY;
  return `
    <h1>Varlock SSR Test</h1>
    <p class="public-var">${ENV.PUBLIC_VAR}</p>
    <p class="api-url">${ENV.API_URL}</p>
    <p class="has-sensitive">${hasSensitive ? 'sensitive-var-available' : 'not-available'}</p>
  `;
}
