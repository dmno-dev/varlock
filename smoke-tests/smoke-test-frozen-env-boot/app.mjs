import 'varlock/auto-load';
import { ENV } from 'varlock/env';

// print comparison results rather than raw values, so redaction can't hide what we assert on
console.log(`APP_ENV=${ENV.APP_ENV}`);
console.log(`SECRET_OK=${ENV.SECRET_TOKEN === 'prod-token' && process.env.SECRET_TOKEN === 'prod-token'}`);
// a boot value is coerced to the type the freeze recorded
console.log(`PORT=${ENV.PORT}`);
console.log(`PORT_IS_NUMBER=${typeof ENV.PORT === 'number'}`);
console.log(`PORT_env=${process.env.PORT}`);
console.log(`INSTANCE_ID=${JSON.stringify(ENV.INSTANCE_ID)}`);
console.log(`LOG_TAG=${ENV.LOG_TAG}`);
