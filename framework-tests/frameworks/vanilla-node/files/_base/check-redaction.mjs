// Tests that console redaction is working for sensitive values
import { ENV } from 'varlock/env';

// Log public vars (should appear in output)
console.log('public::', ENV.PUBLIC_VAR);

// Log sensitive value (should be redacted in output)
console.log('secret::', ENV.SECRET_TOKEN);
console.log(`interpolated secret: ${ENV.SECRET_TOKEN}`);
console.error(`stderr secret: ${process.env.SECRET_TOKEN}`);

// Verify the actual value is correct in memory
if (ENV.SECRET_TOKEN !== 'super-secret-token-12345') {
  process.exit(1);
}

console.log('redaction-test-done');
