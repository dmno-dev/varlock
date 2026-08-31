import { defineConfig, fontProviders, passthroughImageService } from 'astro/config';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import starlight from '@astrojs/starlight';
import mdx from '@astrojs/mdx';
import vue from '@astrojs/vue';
import sitemap from '@astrojs/sitemap';
import robotsTxt from 'astro-robots-txt';
import starlightLlmsTxt from 'starlight-llms-txt';
import partytown from '@astrojs/partytown';
import remarkCustomHeaderId from 'remark-custom-header-id';
import { outdent } from 'outdent';

import varlockAstroIntegration from '@varlock/astro-integration';
import { ENV } from 'varlock/env';

import envSpecGrammar from '../vscode-plugin/language/env-spec.tmLanguage.json' with { type: 'json' };

import { sidebar } from './src/sidebar';

// https://astro.build/config
export default defineConfig({
  site: 'https://varlock.dev',
  redirects: {
    '/guides/docker': '/integrations/docker/',
    // sandboxing concepts moved under the proxy section, tool recipes into their own ecosystem group
    '/guides/sandboxing': '/guides/proxy/sandboxing/',
    '/guides/sandboxing/minimal': '/sandboxes/minimal/',
    '/guides/sandboxing/fence': '/sandboxes/fence/',
    '/guides/sandboxing/yolobox': '/sandboxes/yolobox/',
    '/guides/sandboxing/agent-safehouse': '/sandboxes/agent-safehouse/',
    '/guides/sandboxing/bubblewrap': '/sandboxes/bubblewrap/',
    '/guides/sandboxing/mxc': '/sandboxes/mxc/',
    // CLI / VS Code / README still link to the bare /env-spec path
    '/env-spec': '/env-spec/overview/',
    '/env-spec/': '/env-spec/overview/',
  },
  vite: {
    resolve: {
      alias: {
        '@': '/src',
      },
    },
    plugins: [
      // astro-iconify uses `export { Props }` (value re-export) for a type-only export.
      // After esbuild strips types, there's no value to bind, so Rollup rejects it.
      // This load hook injects a dummy value export so Rollup has something to resolve.
      {
        name: 'fix-astro-iconify-type-export',
        load(id) {
          if (id.includes('/astro-iconify/') && id.endsWith('/Props.ts')) {
            return `${readFileSync(id, 'utf-8')}\nexport const Props = {};`;
          }
        },
      },
      // css-tree/csso use CJS require() for JSON files which fails under bun's node_modules layout.
      // This plugin inlines the JSON content at build time.
      // See https://github.com/csstree/csstree/issues/314
      {
        name: 'inline-broken-json-requires',
        transform(code, id) {
          if (!code.includes('require(')) return;

          // Match require() calls for JSON files (relative or package specifiers like mdn-data)
          const requirePattern = /require\(['"]([^'"]+\.json)['"]\)/g;
          let modified = false;
          const result = code.replace(requirePattern, (fullMatch, specifier) => {
            let jsonPath;

            if (specifier.startsWith('.')) {
              // Relative path — resolve from the file's directory
              jsonPath = resolve(id, '..', specifier);
            } else {
              // Package specifier (e.g. 'mdn-data/css/at-rules.json')
              // Resolve from the requiring file's node_modules
              const parts = id.split('/node_modules/');
              if (parts.length < 2) return fullMatch;
              const nodeModulesDir = `${parts.slice(0, -1).join('/node_modules/')}/node_modules`;
              jsonPath = resolve(nodeModulesDir, specifier);
            }

            try {
              const json = readFileSync(jsonPath, 'utf-8');
              modified = true;
              return JSON.stringify(JSON.parse(json));
            } catch {
              return fullMatch;
            }
          });

          if (modified) return { code: result };
        },
      },
    ],
  },
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
      weights: ['300', '400', '700'],
    },
  ],
  image: {
    service: passthroughImageService(),
  },
  integrations: [
    varlockAstroIntegration(),
    starlight({
      title: 'varlock',
      favicon: '/favicon.png',
      disable404Route: true,
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/dmno-dev/varlock' },
        { icon: 'discord', label: 'Discord', href: 'https://chat.dmno.dev' },
      ],
      logo: { src: './src/assets/logos/logo-1x.png' },
      routeMiddleware: './src/route-data.ts', // adds the Open Graph images.
      components: {
        Head: '@/components/CustomHead.astro',
        ThemeSelect: '@/components/ThemeSelect.astro',
        PageTitle: '@/components/PageTitle.astro',
        ThemeProvider: '@/components/CustomStarlightThemeProvider.astro',
        SocialIcons: '@/components/SocialIcons.astro',
        Footer: '@/components/Footer.astro',
        Sidebar: '@/components/TabbedSidebar.astro',
      },
      customCss: ['@/styles/global.css'],
      plugins: [
        starlightLlmsTxt({
          projectName: 'Varlock',
          description:
            'Varlock is an open source CLI and library for AI-safe .env files. A .env.schema declares and validates '
            + 'environment variables, secrets are encrypted locally or loaded from external providers, and redaction plus a '
            + 'credential proxy keep secret values away from logs, terminals, and AI agents.',
          details: outdent`
            When to use varlock:

            - Managing .env files across development, CI, and production environments
            - Declaring env vars in a .env.schema with decorators like @type, @required, and @sensitive
            - Validating configuration at startup so misconfiguration fails early with clear errors
            - Encrypting local overrides in .env.local so nothing sensitive sits in plaintext
            - Loading secrets from 1Password, AWS, Azure, GCP, HashiCorp Vault, Infisical, Doppler, Bitwarden, and other providers via plugins
            - Redacting secret values from logs and console output at runtime
            - Giving AI coding agents full context on config (names, types, docs) without exposing secret values
            - Running agents and MCP servers behind the varlock proxy so they only ever see placeholder credentials
            - Scanning a repo for leaked secrets with \`varlock scan\`

            Install:

            \`\`\`bash
            npx varlock init                 # add to a JS/TS project
            npm install varlock              # or add the dependency directly
            brew install dmno-dev/tap/varlock  # standalone binary via Homebrew
            curl -sSfL https://varlock.dev/install.sh | sh -s   # standalone binary via script
            \`\`\`

            Common CLI commands: \`varlock init\`, \`varlock load\`, \`varlock run -- <cmd>\`, \`varlock encrypt\`, \`varlock scan\`, \`varlock proxy\`.

            Every page on varlock.dev can be fetched as markdown by sending an \`Accept: text/markdown\` header. The docs are also searchable over MCP at https://docs.mcp.varlock.dev/mcp (streamable HTTP) and https://docs.mcp.varlock.dev/sse.
          `,
          optionalLinks: [
            { label: 'GitHub repository', url: 'https://github.com/dmno-dev/varlock', description: 'source code, issues, and discussions' },
            { label: 'npm package', url: 'https://www.npmjs.com/package/varlock' },
            { label: 'Changelog', url: 'https://github.com/dmno-dev/varlock/blob/main/packages/varlock/CHANGELOG.md' },
            { label: 'Docs MCP server card', url: 'https://varlock.dev/.well-known/mcp/server-card.json', description: 'MCP transports for searching these docs' },
            { label: 'Agent skills index', url: 'https://varlock.dev/.well-known/agent-skills/index.json', description: 'SKILL.md files for coding agents' },
            { label: 'Varlock skill (SKILL.md)', url: 'https://varlock.dev/.well-known/agent-skills/varlock/SKILL.md' },
            { label: 'AI catalog (ARD)', url: 'https://varlock.dev/.well-known/ai-catalog.json' },
            { label: 'Blog', url: 'https://varlock.dev/blog/' },
            { label: 'Discord', url: 'https://chat.dmno.dev' },
          ],
          customSets: [
            {
              label: 'Getting started and CLI reference',
              description: 'installation, core concepts, env-spec syntax, decorators, and every CLI command',
              paths: ['getting-started/**', 'reference/**', 'env-spec/**'],
            },
            {
              label: 'AI tools, MCP and proxy',
              description: 'using varlock with coding agents, MCP servers, and the credential proxy',
              paths: ['guides/ai-tools{,/**}', 'guides/mcp{,/**}', 'guides/proxy{,/**}'],
            },
            {
              label: 'Framework and language integrations',
              description: 'Next.js, Vite, Astro, Bun, Python, Go, Rust, Java, PHP, Docker, CI, and more',
              paths: ['integrations/**'],
            },
            {
              label: 'Secret provider plugins',
              description: '1Password, AWS, Azure, GCP, Vault, Infisical, Doppler, Bitwarden, Kubernetes, and other providers',
              paths: ['plugins/**'],
            },
            {
              label: 'Sandboxes',
              description: 'sandboxing recipes for running agents with the proxy',
              paths: ['sandboxes/**'],
            },
          ],
          promote: ['getting-started/**', 'reference/cli/**'],
          exclude: ['sandboxes/**'],
        }),
      ],
      head: [
        // add sitemap to head for discoverability
        { tag: 'link', attrs: { rel: 'sitemap', href: '/sitemap-index.xml' } },
        // agent discovery hints
        { tag: 'link', attrs: { rel: 'ai-catalog', href: '/.well-known/ai-catalog.json', type: 'application/json' } },
        {
          tag: 'link',
          attrs: {
            rel: 'alternate', href: '/llms.txt', type: 'text/markdown', title: 'llms.txt',
          },
        },
        // Open Graph and Twitter Card defaults (page-specific values override via head)
        { tag: 'meta', attrs: { property: 'og:type', content: 'website' } },
        { tag: 'meta', attrs: { property: 'og:site_name', content: 'Varlock' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        {
          tag: 'script',
          content: `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init bs ws ge fs capture De Ai $s register register_once register_for_session unregister unregister_for_session Is getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey canRenderSurveyAsync identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty xs Ss createPersonProfile Es gs opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing ys debug ks getPageViewId captureTraceFeedback captureTraceMetric".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
        if (window.location.host.includes('varlock.dev')) posthog.init("${ENV.POSTHOG_API_KEY}", {
        api_host: '${ENV.POSTHOG_API_HOST}',
        })`,
        },
      ],
      sidebar,
      expressiveCode: {
        shiki: {
          langs: [
            // @ts-ignore
            { name: 'env-spec', ...envSpecGrammar },
          ],
        },
      },
    }),
    mdx(),
    vue(),
    sitemap(),
    robotsTxt({
      sitemap: true,
      policy: [
        {
          userAgent: '*',
          // The next line enables or disables the crawling on the `robots.txt` level outside of production.
          disallow: ENV.VARLOCK_ENV === 'production' ? '' : '/',
        },
      ],
      transform(content) {
        const extraLines = [
          'Content-Signal: ai-train=no, search=yes, ai-input=no',
          // Agentic Resource Discovery manifest
          'Agentmap: https://varlock.dev/.well-known/ai-catalog.json',
        ];
        let out = content.trimEnd();
        for (const line of extraLines) {
          if (!out.includes(line)) out += `\n${line}`;
        }
        return `${out}\n`;
      },
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
