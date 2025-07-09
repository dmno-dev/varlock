// @ts-check
import { defineConfig, fontProviders, passthroughImageService } from 'astro/config';
import starlight from '@astrojs/starlight';
import mdx from '@astrojs/mdx';
import vue from '@astrojs/vue';
import sitemap from '@astrojs/sitemap';
import robotsTxt from 'astro-robots-txt';
import starlightLlmsTxt from 'starlight-llms-txt';
import partytown from '@astrojs/partytown';

// TODO: figure out why this does not like `import 'varlock/auto-load';`
import { load as varlockLoad } from 'varlock';
import { ENV } from 'varlock/env';

await varlockLoad();

import envSpecGrammar from '../vscode-plugin/language/env-spec.tmLanguage.json' assert { type: 'json' };
import remarkCustomHeaderId from 'remark-custom-header-id';

// https://astro.build/config
export default defineConfig({
  site: 'https://varlock.dev',
  vite: {
    resolve: {
      alias: {
        '@': '/src',
      },
    },
  },
  experimental: {
    fonts: [
      {
        provider: fontProviders.google(),
        name: 'JetBrains Mono',
        cssVariable: '--font-jetbrains-mono',
      },
      {
        provider: fontProviders.google(),
        name: 'Inter',
        cssVariable: '--font-default',
      },
    ],
  },
  image: {
    service: passthroughImageService(),
  },
  integrations: [
    starlight({
      title: 'varlock',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/dmno-dev/varlock' }],
      logo: { src: './src/assets/logos/logo-pixel.png' },
      routeMiddleware: './src/route-data.ts', // adds the Open Graph images.
      components: {
        Head: '@/components/CustomHead.astro',
        ThemeSelect: '@/components/ThemeSelect.astro',
        ThemeProvider: '@/components/CustomStarlightThemeProvider.astro',
      },
      customCss: ['@/styles/global.css'],
      plugins: [starlightLlmsTxt()],
      head: [
        // add sitemap to head for discoverability
        { tag: 'link', attrs: { rel: 'sitemap', href: '/sitemap-index.xml' } },
        {
          tag: 'script',
          content: `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init bs ws ge fs capture De Ai $s register register_once register_for_session unregister unregister_for_session Is getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey canRenderSurveyAsync identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty xs Ss createPersonProfile Es gs opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing ys debug ks getPageViewId captureTraceFeedback captureTraceMetric".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
        if (window.location.host.includes('varlock.dev')) posthog.init("${ENV.POSTHOG_API_KEY}", {
        api_host: '${ENV.POSTHOG_API_HOST}',
        })`,
        },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [{ label: 'Installation', slug: 'getting-started/installation' }],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Schema', slug: 'guides/schema' },
            { label: 'Integration', slug: 'guides/integration' },
            { label: 'Next.js', slug: 'guides/nextjs' },
            { label: 'Secrets', slug: 'guides/secrets' },
            { label: 'Environments', slug: 'guides/environments' },
            // { label: 'Cursor', slug: 'guides/cursor', badge: 'New' },
            { label: 'Migrate from dotenv', slug: 'guides/migrate-from-dotenv' },
            { label: 'Telemetry', slug: 'guides/telemetry' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI', slug: 'reference/cli-commands' },
            { label: 'Root decorators', slug: 'reference/root-decorators' },
            { label: 'Item decorators', slug: 'reference/item-decorators' },
            { label: '> @type data types', slug: 'reference/data-types' },
            { label: 'Value functions', slug: 'reference/functions' },
          ],
        },
        {
          label: '@env-spec',
          items: [
            { label: 'Overview', slug: 'env-spec/overview' },
            { label: 'Reference', slug: 'env-spec/reference' },
            // { label: 'Best practices', slug: 'env-spec/best-practices' },
            { label: 'VS Code extension', slug: 'env-spec/vs-code-ext' },
          ],
        },
      ],
      expressiveCode: {
        shiki: {
          langs: [
            {
              name: 'env-spec',
              scopeName: 'source.env-spec',
              extensions: ['.env-spec'],
              ...envSpecGrammar,
            },
          ],
        },
      },
    }),
    mdx(),
    vue(),
    sitemap(),
    robotsTxt({
      sitemap: false,
      policy: [
        {
          userAgent: '*',
          // The next line enables or disables the crawling on the `robots.txt` level
          // TODO: use varlock, check more general APP_ENV
          disallow: ENV.CF_PAGES_BRANCH !== 'main' ? '/' : '',
        },
      ],
    }),
    partytown({
      // Example: Add dataLayer.push as a forwarding-event.
      config: {
        forward: ['dataLayer.push'],
      },
    }),
  ],
  markdown: {
    remarkPlugins: [remarkCustomHeaderId],
  },
});
