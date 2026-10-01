// No .env files live in this directory, so there is nothing for auto-load to load
import 'varlock/auto-load';
import { ENV } from 'varlock/env';

console.log(`DOWNSTREAM_RAN API_URL=${ENV.API_URL}`);
