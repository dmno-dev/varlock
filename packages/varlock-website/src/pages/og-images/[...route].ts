import { getCollection } from 'astro:content';
import { OGImageRoute } from 'astro-og-canvas';

const DEFAULT_OG_DESCRIPTION =
  'AI-safe .env files: schemas for agents, secrets for humans.';

const docsEntries = await getCollection('docs');
const blogEntries = await getCollection('blog');

// Map docs: [{ id: 'post.md', data: { title: 'Example', description: '' } }]
// to { 'post.md': { title: 'Example', description: '' } }
const docsPages = Object.fromEntries(docsEntries.map(({ id, data }) => [id, data]));

// Map blog: [{ id: 'slug', data: { title, description } }]
// to { 'blog/slug': { title, description } }
const blogPages = Object.fromEntries(
  blogEntries.map(({ id, data }) => [`blog/${id}`, { title: data.title, description: data.description }]),
);

export const { getStaticPaths, GET } = OGImageRoute({
  // Tell us the name of your dynamic route segment.
  // In this case it's `route`, because the file is named `[...route].ts`.
  param: 'route',

  pages: {
    ...docsPages,
    ...blogPages,
    index: {
      title: 'Varlock',
      description: 'AI-safe .env files: schemas for agents, secrets for humans.',
    },
    blog: {
      title: 'Blog',
      description: 'Updates, guides, and tips from the Varlock team.',
    },
  },

  getImageOptions: (path, page) => {
    const description =
      (page.description as string | undefined)?.trim() || DEFAULT_OG_DESCRIPTION;
    return {
      title: page.title,
      description,
      logo: {
        path: './src/assets/logos/wordmark-sm.png',
      },
      font: {
        title: {
          color: [236, 48, 48],
        },
        description: {
          color: [255, 255, 255],
          size: 40,
        },
      },
    };
  },
});
