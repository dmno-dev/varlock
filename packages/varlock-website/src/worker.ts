/**
 * Cloudflare Worker entrypoint for varlock.dev.
 *
 * Static assets are served first by the platform; this script is only invoked when no asset
 * matches the request path (run_worker_first is not enabled). That makes it a 404 handler:
 *
 * - Browsers (Accept includes text/html) get the normal 404 page from dist/404.html.
 * - Agents and tools that ask for markdown/plain text/JSON, or send no HTML preference at all
 *   (curl's default is `*\/*`), get a short text/markdown body that points at the site's
 *   machine-readable entry points so they can recover instead of parsing a 32KB HTML shell.
 */

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

const SITE = 'https://varlock.dev';

const RECOVERY_LINKS: Array<[label: string, path: string]> = [
  ['Home', '/'],
  ['Docs index for agents (llms.txt)', '/llms.txt'],
  ['Full docs as a single file', '/llms-full.txt'],
  ['Sitemap', '/sitemap-index.xml'],
  ['Getting started', '/getting-started/introduction/'],
  ['Agent skills index', '/.well-known/agent-skills/index.json'],
  ['Docs MCP server card', '/.well-known/mcp/server-card.json'],
  ['AI catalog (ARD)', '/.well-known/ai-catalog.json'],
];

interface MediaRange {
  type: string;
  subtype: string;
  quality: number;
}

function parseAccept(accept: string): Array<MediaRange> {
  return accept.split(',').flatMap((entry) => {
    const [mediaType = '', ...parameters] = entry.trim().toLowerCase().split(';');
    const [type, subtype] = mediaType.split('/');
    if (!type || !subtype) return [];

    const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith('q='));
    const parsedQuality = qualityParameter ? Number(qualityParameter.trim().slice(2)) : 1;
    const quality = parsedQuality >= 0 && parsedQuality <= 1 ? parsedQuality : 0;
    return [{ type, subtype, quality }];
  });
}

function qualityFor(mediaType: string, ranges: Array<MediaRange>) {
  const [type, subtype] = mediaType.split('/');
  let bestSpecificity = -1;
  let quality = 0;

  for (const range of ranges) {
    if (range.type !== '*' && range.type !== type) continue;
    if (range.subtype !== '*' && range.subtype !== subtype) continue;

    const specificity = Number(range.type !== '*') + Number(range.subtype !== '*');
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      quality = range.quality;
    } else if (specificity === bestSpecificity) {
      quality = Math.max(quality, range.quality);
    }
  }

  return quality;
}

function wantsTextResponse(accept: string) {
  if (!accept.trim()) return true;

  const ranges = parseAccept(accept);
  const htmlQuality = qualityFor('text/html', ranges);
  const markdownQuality = qualityFor('text/markdown', ranges);
  const textAliasQuality = Math.max(
    ...ranges
      .filter(({ type, subtype }) => (type === 'text' && subtype === 'plain')
        || (type === 'application' && subtype === 'json'))
      .map(({ quality }) => quality),
    0,
  );
  const textQuality = Math.max(markdownQuality, textAliasQuality);

  return textQuality > 0 && textQuality >= htmlQuality;
}

function sanitizePath(pathname: string) {
  return pathname.replace(/[^A-Za-z0-9/._-]/g, '').slice(0, 200) || '/';
}

function markdown404(pathname: string) {
  const lines = [
    '# 404: page not found',
    '',
    `\`${sanitizePath(pathname)}\` does not exist on varlock.dev. Useful entry points:`,
    '',
    ...RECOVERY_LINKS.map(([label, path]) => `- ${label}: ${SITE}${path}`),
    '',
    'Any docs page can be fetched as markdown by sending `Accept: text/markdown`.',
    '',
  ];
  return lines.join('\n');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const accept = request.headers.get('accept') ?? '';
    const wantsText = wantsTextResponse(accept);
    let assetRequest = request;
    if (wantsText && (request.headers.has('if-none-match') || request.headers.has('if-modified-since'))) {
      const headers = new Headers(request.headers);
      headers.delete('if-none-match');
      headers.delete('if-modified-since');
      assetRequest = new Request(request, { headers });
    }

    const assetResponse = await env.ASSETS.fetch(assetRequest);
    if (assetResponse.status !== 404) return assetResponse;
    if (!wantsText) return assetResponse;

    const body = request.method === 'HEAD' ? null : markdown404(new URL(request.url).pathname);
    return new Response(body, {
      status: 404,
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
      },
    });
  },
};
