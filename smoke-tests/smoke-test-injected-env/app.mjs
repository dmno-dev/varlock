import 'varlock/auto-load';
import { ENV } from 'varlock/env';

// print comparison results rather than raw values, so redaction can't hide what we assert on
console.log(`PUBLIC_VAR=${ENV.PUBLIC_VAR}`);
console.log(`SECRET_OK=${ENV.SECRET_TOKEN === 'secret-token-val' && process.env.SECRET_TOKEN === 'secret-token-val'}`);
console.log(`OVERRIDE_ME=${ENV.OVERRIDE_ME}`);
