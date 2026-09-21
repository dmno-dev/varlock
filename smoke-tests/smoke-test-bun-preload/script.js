// env is expected to come from the bunfig.toml preload of varlock/auto-load,
// not from an explicit import or `varlock run`
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PUBLIC_VAR:', process.env.PUBLIC_VAR);
console.log('SECRET_TOKEN:', process.env.SECRET_TOKEN);
if (process.env.PUBLIC_VAR !== 'public-value' || process.env.SECRET_TOKEN !== 'super-secret-token-12345') {
  console.error('env not loaded');
  process.exit(1);
}
console.log('preload ok');
