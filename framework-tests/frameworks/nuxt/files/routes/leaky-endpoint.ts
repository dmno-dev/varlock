import { ENV } from 'varlock/env';

// Returns a sensitive value straight to the client — varlock's patched response
// objects should catch this before it reaches the network.
export default defineEventHandler(() => `token is ${ENV.SENSITIVE_VAR}`);
