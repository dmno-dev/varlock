// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import starlight from '@astrojs/starlight';
import mdx from '@astrojs/mdx';
import vue from '@astrojs/vue';

// https://astro.build/config
export default defineConfig({
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
        name: "Pixelify Sans",
        cssVariable: "--font-pixelify"
      },
      {
        provider: fontProviders.google(),
        name: "JetBrains Mono",
        cssVariable: "--font-jetbrains-mono"
      },
    ],
  },
  integrations: [
    starlight({
      title: 'varlock 🔐 🧙‍♂️',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/withastro/starlight' }],
      components: {
        Head: '@/components/CustomHead.astro',
      },
      customCss: ['@/styles/global.css'],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Installation', slug: 'getting-started/installation' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Secrets', slug: 'guides/secrets' },
            { label: 'Security', slug: 'guides/security' },
            { label: 'Migration from dotenv', slug: 'guides/migration-from-dotenv' },
            { label: 'Javascript ecosystem', slug: 'guides/javascript-ecosystem' },
            { label: 'Other languages', slug: 'guides/other-languages' },
          ],
        },
        {
          label: 'Reference',
          autogenerate: { directory: 'reference' },
        },
      ],
    }),
    mdx(),
    vue(),
  ],
});
