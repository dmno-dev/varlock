import { dirname } from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Debug from 'debug';
import { varlockVitePlugin, varlockLoadedEnv } from '@varlock/vite-integration';
import type { AstroIntegration } from 'astro';
import { initVarlockEnv, scanForLeaks } from 'varlock/env';

const debug = Debug('varlock:astro-integration');

debug('Loaded varlock astro integration file');
const startLoadAt = new Date();

const __dirname = dirname(fileURLToPath(import.meta.url));

let astroCommand: 'dev' | 'build' | 'preview' | 'sync' | undefined;

let ssrOutputDirPath: string;
let adapterName: string | undefined;

const vitePluginInstance = varlockVitePlugin();

// enables throwing when user accesses a bad key on ENV
(globalThis as any).__varlockThrowOnMissingKeys = true;


const enableLeakDetection = true;

const loadingTime = +new Date() - +startLoadAt;
debug(`Initial varlock env load completed in ${loadingTime}ms`);


async function prependFile(filePath: string, textToPrepend: string) {
  const originalFileContents = await fs.promises.readFile(filePath, 'utf8');
  await fs.promises.writeFile(filePath, `${textToPrepend}\n\n${originalFileContents}`);
}


function varlockAstroIntegration(
  integrationOptions?: {
    /** controls if/how varlock init code is injected into the built application code  */
    injectMode?: 'resolved-env' | 'auto-load' | 'init' | 'none';
  },
): AstroIntegration {
  return {
    name: 'varlock-astro-integration',
    hooks: {
      'astro:config:setup': async (opts) => {
        const {
          updateConfig, addMiddleware, injectScript, command,
          // config, , isRestart,
          // addRenderer, addClientDirective,
          // addDevToolbarApp, addWatchFile,
          // injectRoute, createCodegenDir, logger,
        } = opts;

        astroCommand = command;

        // we may want to be smarter about bailing here if config is invalid and we are in build mode

        // TODO: re-enable client-side loading of dynamic vars if not static and public dynamic keys exist?

        updateConfig({
          vite: {
            plugins: [vitePluginInstance as any],
          },
        });

        // inject script into CLIENT context
        const clientInjectedCode = ['globalThis.__varlockThrowOnMissingKeys = true;'];
        if (astroCommand === 'dev') {
          clientInjectedCode.push(
            '// NOTE - this is only injected during development, to give better error messages',
            `globalThis.__varlockValidKeys = ${JSON.stringify(Object.keys(varlockLoadedEnv?.config || {}))};`,
          );
        }
        injectScript('page', clientInjectedCode.join('\n'));

        // TODO: let user opt out of this?
        if (enableLeakDetection) {
          // add leak detection middleware!
          addMiddleware({
            entrypoint: `${__dirname}/astro-middleware.js`,
            order: 'post', // not positive on this?
          });
        }
      },

      'astro:config:done': async (opts) => {
        ssrOutputDirPath = opts.config.build.server.pathname;
        adapterName = opts.config.adapter?.name;
      },

      'astro:build:ssr': async (opts) => {
        // console.log('build:ssr', opts);
        if (!ssrOutputDirPath) throw new Error('Did not set ssr output path');

        // we will let the user explicitly control how to inject our varlock code
        // but in most cases we will infer it from the settings and selected adapter
        let injectMode = integrationOptions?.injectMode;

        // not sure if this will be needed, but seems like it could be
        if (injectMode === 'none') return;

        // For some platforms (vercel/netlify/etc) and using their adapters, we need to inject the resolved config at build time
        // because we don't have control over how the server side code is run (ie cannot use `varlock run`)
        // also these adapters sometimes break things up into many entrypoints where we may need to re-inject thigns in many places
        if (!injectMode) {
          // do we want to do this for _any_ adapter that isn't node?
          if (['@astrojs/netlify', '@astrojs/vercel', '@astrojs/cloudflare'].includes(adapterName || '')) {
            injectMode = 'resolved-env';
          } else if (adapterName === '@astrojs/node') {
            injectMode = 'auto-load';
          }
        }

        const injectGlobalCode = [] as Array<string>;
        injectGlobalCode.push('// injected by varlock astro integration ----');
        injectGlobalCode.push('globalThis.__varlockThrowOnMissingKeys = true;');


        if (injectMode === 'auto-load') {
          injectGlobalCode.push("import 'varlock/auto-load';");
        } else {
          if (injectMode === 'resolved-env') {
            injectGlobalCode.push(`globalThis.__varlockLoadedEnv = ${JSON.stringify(varlockLoadedEnv)};`);
          }
          injectGlobalCode.push(`
import { initVarlockEnv } from 'varlock/env';
import { patchGlobalConsole } from 'varlock/patch-console';
import { patchGlobalServerResponse } from 'varlock/patch-server-response';
import { patchGlobalResponse } from 'varlock/patch-response';

initVarlockEnv();
patchGlobalConsole();
patchGlobalServerResponse();
patchGlobalResponse();
          `);
        }
        injectGlobalCode.push('// --- end varlock injected code ---');
        const injectGlobalCodeStr = injectGlobalCode.join('\n');

        if (opts.manifest.entryModules['\x00@astrojs-ssr-virtual-entry']) {
          const entryPath = ssrOutputDirPath + opts.manifest.entryModules['\x00@astrojs-ssr-virtual-entry'];
          await prependFile(entryPath, injectGlobalCodeStr);
        }

        if (opts.middlewareEntryPoint) {
          const middlewareEntryPath = fileURLToPath(opts.middlewareEntryPoint);
          await prependFile(middlewareEntryPath, injectGlobalCodeStr);
        }

        // we may need to inject into more places for certain adapters - will require more testing
      },

      // TODO: re-enable checking for dynamic config used during pre-render
    },
  };
}

export default varlockAstroIntegration;
