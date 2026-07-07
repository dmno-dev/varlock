/**
 * Icons for plugin/integration doc page titles, reusing the homepage
 * "works with" tile icons as the single source of truth.
 */
import { WORKS_WITH_TILES } from './works-with-tiles';

/** Pages without a homepage tile */
const EXTRA_PAGE_ICONS: Record<string, string> = {
  'plugins/kubernetes': 'simple-icons:kubernetes',
  'integrations/python': 'simple-icons:python',
  'integrations/mise': 'mdi:chef-hat',
};

/**
 * Look up the icon for a docs page by its Starlight route id (e.g. `plugins/1password`).
 * Only plugin and integration pages get icons.
 */
export function getDocsPageIcon(routeId: string): string | undefined {
  const id = routeId.replace(/^\/+|\/+$/g, '');
  if (!id.startsWith('plugins/') && !id.startsWith('integrations/')) return undefined;
  if (EXTRA_PAGE_ICONS[id]) return EXTRA_PAGE_ICONS[id];

  // prefer a tile whose id matches the page slug (e.g. `other-languages`),
  // otherwise fall back to the first tile linking to this page
  const slug = id.split('/').pop()!;
  const idMatch = WORKS_WITH_TILES.find((t) => t.id === slug);
  if (idMatch?.icon) return idMatch.icon;
  const href = `/${id}/`;
  return WORKS_WITH_TILES.find((t) => t.href?.split('#')[0] === href)?.icon;
}
