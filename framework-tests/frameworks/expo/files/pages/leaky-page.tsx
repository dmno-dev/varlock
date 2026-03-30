import { ENV } from 'varlock/env';

// Deliberately render sensitive value inline — the babel plugin should NOT
// inline this, so the literal secret value must not appear in the output.
export default function Page() {
  return `Secret: ${ENV.SECRET_KEY}`;
}
