import 'varlock/auto-load';
import { ENV } from 'varlock/env';

// print comparison results rather than raw values, so redaction can't hide what we assert on
console.log(`APP_ENV=${ENV.APP_ENV}`);
console.log(`PUBLIC_VAR=${ENV.PUBLIC_VAR}`);
console.log(`SECRET_OK=${ENV.SECRET_TOKEN === 'prod-token' && process.env.SECRET_TOKEN === 'prod-token'}`);
// types survive the freeze/thaw round trip - a string "true" would fail this
console.log(`COERCED_FLAG_IS_BOOL=${ENV.COERCED_FLAG === true}`);

// the seal is total: it wins over anything the operator sets at boot, and process.env
// is kept in agreement with ENV so nothing reads one resolution while something else
// reads another. printed raw so the tests can assert on both halves.
console.log(`SEALED_UNSET_env=${JSON.stringify(process.env.UNSET_IN_SEAL)}`);
console.log(`SEALED_UNSET_ENV=${JSON.stringify(ENV.UNSET_IN_SEAL)}`);
console.log(`SEALED_SET_env=${JSON.stringify(process.env.PUBLIC_VAR)}`);
