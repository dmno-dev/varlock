import 'varlock/auto-load';
import { ENV } from 'varlock/env';

// JSON.stringify so `undefined`, `""`, and `"some-value"` are all distinguishable
console.log(`SET_VAR=${JSON.stringify(process.env.SET_VAR)}`);
console.log(`UNSET_VAR=${JSON.stringify(process.env.UNSET_VAR)}`);
console.log(`UNSET_VAR_PRESENT=${'UNSET_VAR' in process.env}`);
console.log(`UNSET_VAR_FALLBACK=${process.env.UNSET_VAR ?? 'fallback-value'}`);
console.log(`EMPTY_VAR=${JSON.stringify(process.env.EMPTY_VAR)}`);
console.log(`ENV_UNSET_VAR=${JSON.stringify(ENV.UNSET_VAR)}`);
