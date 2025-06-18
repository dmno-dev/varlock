/*
  This file is exposed as `varlock/config` so that when using overrides to sub in varlock for dotenv
  `import dotenv/config` will import this instead!

  We'll want to make sure that there is a similar compat availble when importing via CJS
  but this will have to be on the default export of the package

  SEE https://github.com/motdotla/dotenv
*/
import { load } from './index';

// TODO: this should probably not be async
// eslint-disable-next-line es-x/no-top-level-await
await load();
