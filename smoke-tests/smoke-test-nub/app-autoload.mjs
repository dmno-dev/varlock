import 'varlock/auto-load';
console.log('PUBLIC_VAR:', process.env.PUBLIC_VAR);
console.log('SECRET_TOKEN:', process.env.SECRET_TOKEN);
console.log('marker:', process.env.__VARLOCK_CLI_CHILD);
console.log('auto-load ok');
