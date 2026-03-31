// Verifies that `varlock run` injects env vars into process.env
// WITHOUT importing anything from varlock
const errors = [];

if (process.env.PUBLIC_VAR !== 'hello-world') {
  errors.push(`PUBLIC_VAR expected 'hello-world', got '${process.env.PUBLIC_VAR}'`);
}
if (process.env.API_URL !== 'https://api.example.com') {
  errors.push(`API_URL expected 'https://api.example.com', got '${process.env.API_URL}'`);
}
if (process.env.SECRET_TOKEN !== 'super-secret-token-12345') {
  errors.push(`SECRET_TOKEN expected 'super-secret-token-12345', got '${process.env.SECRET_TOKEN}'`);
}

if (errors.length > 0) {
  console.error('ERRORS:', errors.join('; '));
  process.exit(1);
}

console.log('process-env-only-ok');
console.log(`public::${process.env.PUBLIC_VAR}`);
console.log(`api::${process.env.API_URL}`);
console.log(`has-secret::${process.env.SECRET_TOKEN ? 'yes' : 'no'}`);
