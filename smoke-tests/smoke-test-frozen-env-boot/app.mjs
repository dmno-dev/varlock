import 'varlock/auto-load';
import { ENV } from 'varlock/env';

// print comparison results rather than raw values, so redaction can't hide what we assert on
console.log(`APP_ENV=${ENV.APP_ENV}`);
console.log(`SECRET_OK=${ENV.SECRET_TOKEN === 'prod-token' && process.env.SECRET_TOKEN === 'prod-token'}`);
// boot keys are resolved against the schema at boot, so coercion applies to them too
console.log(`PORT=${ENV.PORT}`);
console.log(`PORT_IS_NUMBER=${typeof ENV.PORT === 'number'}`);
console.log(`INSTANCE_ID=${JSON.stringify(ENV.INSTANCE_ID)}`);
console.log(`PUBLIC_URL=${ENV.PUBLIC_URL}`);
