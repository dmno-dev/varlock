#!/usr/bin/env node

// Test script to verify varlock log redaction works with interactive output
// This simulates real-world scenarios with stdout, stderr, and multiple writes

console.log('=== Interactive Script Test ===');

// Test 1: Regular stdout
console.log('Step 1: Regular output');
console.log('SECRET_TOKEN:', process.env.SECRET_TOKEN);

// Test 2: Stderr output (errors often contain secrets)
console.error('Step 2: Error output');
console.error(`Error connecting with token: ${process.env.SECRET_TOKEN}`);

// Test 3: Multiple writes to stdout
process.stdout.write('Step 3: Multiple writes - ');
process.stdout.write(`Token value: ${process.env.SECRET_TOKEN}`);
process.stdout.write('\n');

// Test 4: Multiple writes to stderr
process.stderr.write('Step 4: Stderr writes - ');
process.stderr.write(`Failed auth with: ${process.env.SECRET_TOKEN}`);
process.stderr.write('\n');

// Test 5: Interleaved stdout/stderr
console.log('Step 5: Interleaved output');
console.log('PUBLIC_VAR:', process.env.PUBLIC_VAR);
console.error(`Secret in error: ${process.env.SECRET_TOKEN}`);
console.log('NODE_ENV:', process.env.NODE_ENV);

// Test 6: Secret in the middle of a line
console.log(`Connection string: postgresql://user:${process.env.SECRET_TOKEN}@localhost/db`);

// Verify the values are actually set correctly
if (process.env.SECRET_TOKEN !== 'super-secret-token-12345') {
  console.error('❌ SECRET_TOKEN not loaded correctly');
  process.exit(1);
}

if (process.env.PUBLIC_VAR !== 'public-value') {
  console.error('❌ PUBLIC_VAR not loaded correctly');
  process.exit(1);
}

console.log('\n✅ Interactive script completed successfully');
console.log('Note: All instances of SECRET_TOKEN above should be redacted as ▒▒▒▒▒');
