import { varlockVitePlugin, type VarlockVitePluginOptions } from '@varlock/vite-integration';

export { resolvedEnvVars } from '@varlock/vite-integration';

export function varlockCloudflareVitePlugin(
  options?: Omit<VarlockVitePluginOptions, 'ssrEdgeRuntime' | 'ssrEntryModuleIds' | 'ssrInjectModeDev'>,
) {
  return varlockVitePlugin({
    ...options as VarlockVitePluginOptions,
    ssrEdgeRuntime: true,
    // in dev, bundle resolved env directly since there are no CF secret bindings
    ssrInjectModeDev: 'resolved-env',
    ssrEntryModuleIds: ['\0virtual:cloudflare/worker-entry'],
    ssrEntryCode: [
      // read the resolved env from Cloudflare's secret bindings at runtime
      // the __VARLOCK_ENV secret is uploaded via `varlock-wrangler deploy`
      "import { env as __cfEnv } from 'cloudflare:workers';",
      'if (__cfEnv?.__VARLOCK_ENV) {',
      '  globalThis.__varlockLoadedEnv = JSON.parse(__cfEnv.__VARLOCK_ENV);',
      '}',
      ...(options?.ssrEntryCode ?? []),
    ],
  });
}
