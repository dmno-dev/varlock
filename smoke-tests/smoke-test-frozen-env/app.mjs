import 'varlock/auto-load';
import { ENV } from 'varlock/env';

// print comparison results rather than raw values, so redaction can't hide what we assert on
console.log(`APP_ENV=${ENV.APP_ENV}`);
console.log(`PUBLIC_VAR=${ENV.PUBLIC_VAR}`);
console.log(`SECRET_OK=${ENV.SECRET_TOKEN === 'prod-token' && process.env.SECRET_TOKEN === 'prod-token'}`);
// types survive the freeze/thaw round trip - a string "true" would fail this
console.log(`COERCED_FLAG_IS_BOOL=${ENV.COERCED_FLAG === true}`);
