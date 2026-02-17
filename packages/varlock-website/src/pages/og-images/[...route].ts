import { getCollection } from 'astro:content';
import { OGImageRoute } from 'astro-og-canvas';

const docsEntries = await getCollection('docs');
const blogEntries = await getCollection('blog');

// Map docs: [{ id: 'post.md', data: { title: 'Example', description: '' } }]
// to { 'post.md': { title: 'Example', description: '' } }
const docsPages = Object.fromEntries(docsEntries.map(({ id, data }) => [id, data]));

// Map blog: [{ id: 'slug', data: { title, description } }]
// to { 'blog/slug': { title, description } }
const blogPages = Object.fromEntries(
  blogEntries.map(({ id, data }) => [`blog/${id}`, { title: data.title, description: data.description }])
);

export const { getStaticPaths, GET } = OGImageRoute({
  // Tell us the name of your dynamic route segment.
  // In this case it's `route`, because the file is named `[...route].ts`.
  param: 'route',

  pages: {
    ...docsPages,
    ...blogPages,
    index: {
      title: 'varlock',
      description: 'varlock',
    },
    blog: {
      title: 'Blog',
      description: 'Updates, guides, and tips from the Varlock team.',
    },
  },

  getImageOptions: (path, page) => ({
    title: page.title,
    description: page.description,
    logo: {
      path: './src/assets/logos/wordmark-sm.png',
    },
    font: {
      title: {
        color: [236, 48, 48],
      },
    },
  }),
});
