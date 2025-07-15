import { defineConfig } from 'vite';
// import 'varlock/auto-load';
import { ENV } from 'varlock';
import { varlockVitePlugin } from '@varlock/vite-integration';

console.log(process.env.MODE, process.env.VITE_ENV_SPECIFIC_ITEM);

console.log('loaded env from varlock: ', {
  APP_ENV: ENV.APP_ENV,
  SECRET_FOO: ENV.SECRET_FOO,
});

export default defineConfig({
  plugins: [varlockVitePlugin() as any],
});
