import { getCollection } from 'astro:content';
import { OGImageRoute } from 'astro-og-canvas';

const collectionEntries = await getCollection('docs');

// Map the array of content collection entries to create an object.
// Converts [{ id: 'post.md', data: { title: 'Example', description: '' } }]
// to { 'post.md': { title: 'Example', description: '' } }
const pages = Object.fromEntries(collectionEntries.map(({ id, data }) => [id, data]));

export const { getStaticPaths, GET } = OGImageRoute({
  // Tell us the name of your dynamic route segment.
  // In this case it's `route`, because the file is named `[...route].ts`.
  param: 'route',

  pages: pages,

  getImageOptions: (path, page) => ({
    title: page.title,
    description: page.description,
  }),
});