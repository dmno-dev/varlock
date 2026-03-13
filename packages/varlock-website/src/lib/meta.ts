export type MetaHeadItem = | { tag: 'meta'; attrs?: Record<string, string> }
  | { tag: 'link'; attrs?: Record<string, string> };

/**
 * Generate Open Graph, Twitter Card, and meta description tags for a page.
 * Use with Layout's head prop or route-data's head array.
 */
export function createMetaHead(
  options: {
    title: string;
    description: string;
    url: string;
    ogImageUrl: string;
  },
): Array<MetaHeadItem> {
  const {
    title, description, url, ogImageUrl,
  } = options;
  return [
    { tag: 'meta', attrs: { name: 'description', content: description } },
    { tag: 'meta', attrs: { property: 'og:title', content: title } },
    { tag: 'meta', attrs: { property: 'og:description', content: description } },
    { tag: 'meta', attrs: { property: 'og:url', content: url } },
    { tag: 'meta', attrs: { property: 'og:image', content: ogImageUrl } },
    { tag: 'meta', attrs: { name: 'twitter:title', content: title } },
    { tag: 'meta', attrs: { name: 'twitter:description', content: description } },
    { tag: 'meta', attrs: { name: 'twitter:image', content: ogImageUrl } },
  ];
}
