/**
 * Icons for plugin/integration doc page titles, reusing the homepage
 * "works with" tile icons as the single source of truth.
 */
import { WORKS_WITH_TILES } from './works-with-tiles';

/** Pages without a homepage tile (or whose tile id differs from the page slug) */
const EXTRA_PAGE_ICONS: Record<string, string> = {
  'plugins/kubernetes': 'simple-icons:kubernetes',
};

/**
 * Look up the icon for a docs page by its Starlight route id (e.g. `plugins/1password`).
 * Only plugin and integration pages get icons.
 */
export function getDocsPageIcon(routeId: string): string | undefined {
  const id = routeId.replace(/^\/+|\/+$/g, '');
  // Child pages under plugins/integrations (e.g. kubernetes/setup) inherit the parent icon
  const isIntegrationLike = id.startsWith('plugins/') || id.startsWith('integrations/');
  if (!isIntegrationLike) return undefined;
  if (EXTRA_PAGE_ICONS[id]) return EXTRA_PAGE_ICONS[id];

  // prefer a tile whose id matches the page slug (e.g. `other-languages`),
  // otherwise fall back to the first tile linking to this page
  const parts = id.split('/');
  const slug = parts[parts.length - 1]!;
  const parentSlug = parts.length >= 2 ? parts[1]! : slug;
  const idMatch = WORKS_WITH_TILES.find((t) => t.id === slug)
    ?? WORKS_WITH_TILES.find((t) => t.id === parentSlug);
  if (idMatch?.icon) return idMatch.icon;
  const href = `/${id}/`;
  const parentHref = parts.length >= 2 ? `/${parts[0]}/${parts[1]}/` : href;
  return WORKS_WITH_TILES.find((t) => t.href?.split('#')[0] === href)?.icon
    ?? WORKS_WITH_TILES.find((t) => t.href?.split('#')[0] === parentHref)?.icon;
}
