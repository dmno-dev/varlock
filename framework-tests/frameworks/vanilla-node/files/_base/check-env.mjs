// Verifies that env vars are loaded into process.env and ENV
import { ENV } from 'varlock/env';

const errors = [];

// Check process.env
if (process.env.PUBLIC_VAR !== 'hello-world') {
  errors.push(`process.env.PUBLIC_VAR expected 'hello-world', got '${process.env.PUBLIC_VAR}'`);
}
if (process.env.API_URL !== 'https://api.example.com') {
  errors.push(`process.env.API_URL expected 'https://api.example.com', got '${process.env.API_URL}'`);
}
if (process.env.SECRET_TOKEN !== 'super-secret-token-12345') {
  errors.push(`process.env.SECRET_TOKEN expected 'super-secret-token-12345', got '${process.env.SECRET_TOKEN}'`);
}

// Check ENV proxy
if (ENV.PUBLIC_VAR !== 'hello-world') {
  errors.push(`ENV.PUBLIC_VAR expected 'hello-world', got '${ENV.PUBLIC_VAR}'`);
}
if (ENV.API_URL !== 'https://api.example.com') {
  errors.push(`ENV.API_URL expected 'https://api.example.com', got '${ENV.API_URL}'`);
}
if (ENV.SECRET_TOKEN !== 'super-secret-token-12345') {
  errors.push(`ENV.SECRET_TOKEN expected 'super-secret-token-12345', got '${ENV.SECRET_TOKEN}'`);
}

if (errors.length > 0) {
  console.error('ERRORS:', errors.join('; '));
  process.exit(1);
}

console.log('process-env-ok');
console.log('env-proxy-ok');
console.log(`public::${process.env.PUBLIC_VAR}`);
console.log(`api::${process.env.API_URL}`);
console.log(`has-secret::${ENV.SECRET_TOKEN ? 'yes' : 'no'}`);
