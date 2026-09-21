// env is expected to come from nub handing the run to `varlock run` (it detects .env.schema)
console.log('PUBLIC_VAR:', process.env.PUBLIC_VAR);
console.log('SECRET_TOKEN:', process.env.SECRET_TOKEN);
console.log('under varlock run:', process.env.__VARLOCK_RUN);
if (process.env.PUBLIC_VAR !== 'public-value' || process.env.SECRET_TOKEN !== 'super-secret-token-12345') {
  console.error('env not loaded');
  process.exit(1);
}
console.log('nub ok');
