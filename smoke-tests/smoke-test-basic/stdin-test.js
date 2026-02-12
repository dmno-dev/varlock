#!/usr/bin/env node

// Test script to verify varlock doesn't break stdin
// This simulates tools like the Claude CLI that check stdin availability

console.log('=== Stdin Availability Test ===');

// Check if stdin is available and readable
if (process.stdin.isTTY !== undefined) {
  console.log('stdin.isTTY:', process.stdin.isTTY);
} else {
  console.log('stdin.isTTY: undefined');
}

console.log('stdin.readable:', process.stdin.readable);
console.log('stdin.readableLength:', process.stdin.readableLength);

// Try to check if stdin has data (non-blocking)
if (!process.stdin.isTTY) {
  console.log('stdin appears to be piped/redirected');
} else {
  console.log('stdin appears to be a TTY');
}

// Check that we can still see environment variables
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PUBLIC_VAR:', process.env.PUBLIC_VAR);

// This should be redacted
console.log('SECRET_TOKEN:', process.env.SECRET_TOKEN);

console.log('✅ Stdin test completed - stdin properties are accessible');
