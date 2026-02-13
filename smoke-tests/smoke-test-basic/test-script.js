#!/usr/bin/env node

// Test script to verify varlock functionality
console.log('=== Varlock Smoke Test ===');

// Test 1: Check env vars are loaded
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PUBLIC_VAR:', process.env.PUBLIC_VAR);

// Test 2: Try to log secret (should be redacted)
console.log('SECRET_TOKEN:', process.env.SECRET_TOKEN);

// Test 3: Log the secret in a sentence (should still be redacted)
console.log(`The secret is: ${process.env.SECRET_TOKEN}`);

// Test 4: Verify expected values
const errors = [];

if (process.env.NODE_ENV !== 'test') {
  errors.push(`NODE_ENV expected 'test', got '${process.env.NODE_ENV}'`);
}

if (process.env.PUBLIC_VAR !== 'public-value') {
  errors.push(`PUBLIC_VAR expected 'public-value', got '${process.env.PUBLIC_VAR}'`);
}

if (process.env.SECRET_TOKEN !== 'super-secret-token-12345') {
  errors.push(`SECRET_TOKEN expected 'super-secret-token-12345', got '${process.env.SECRET_TOKEN}'`);
}

if (errors.length > 0) {
  console.error('\n❌ Errors:');
  errors.forEach((err) => console.error(`  - ${err}`));
  process.exit(1);
}

console.log('\n✅ All env vars loaded correctly');
console.log('Note: The SECRET_TOKEN in console output above should be redacted as ▒▒▒▒▒');
