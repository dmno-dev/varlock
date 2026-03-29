// This script tests that varlock's dotenv drop-in replacement works in a vanilla Node.js context.
// Importing 'varlock/config' is the dotenv drop-in replacement (mirrors `import 'dotenv/config'`).
// With schema errors, it should fail with a meaningful error — NOT a JSON parse error.
import 'varlock/config';

console.log('PUBLIC_VAR:', process.env.PUBLIC_VAR);
console.log('App loaded successfully');
