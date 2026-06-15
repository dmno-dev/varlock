import { ENV } from 'varlock/env';

export function NestedDynamicValue() {
  return <p>Nested dynamic public: {ENV.PUBLIC_DYNAMIC_VAR}</p>;
}
