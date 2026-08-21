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

function wantsTextResponse(accept: string) {
  if (/text\/markdown|text\/plain|application\/json/i.test(accept)) return true;
  return !/text\/html/i.test(accept);
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
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) return assetResponse;

    const accept = request.headers.get('accept') ?? '';
    if (!wantsTextResponse(accept)) return assetResponse;

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
