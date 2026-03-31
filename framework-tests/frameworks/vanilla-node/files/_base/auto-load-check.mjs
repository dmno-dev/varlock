// Tests that varlock/auto-load works as a drop-in import
import 'varlock/auto-load';
import { ENV } from 'varlock/env';

if (ENV.PUBLIC_VAR !== 'hello-world') {
  console.error('ENV.PUBLIC_VAR mismatch');
  process.exit(1);
}
if (process.env.PUBLIC_VAR !== 'hello-world') {
  console.error('process.env.PUBLIC_VAR mismatch');
  process.exit(1);
}

// Log sensitive value to test that auto-load enables redaction
console.log('secret::', ENV.SECRET_TOKEN);

console.log('auto-load-ok');
