import { describe, expect, it } from 'vitest';

import worker from './worker';

function createEnv(fetch: (request: Request) => Response) {
  return {
    ASSETS: {
      fetch: async (request: Request) => fetch(request),
    },
  };
}

describe('404 worker', () => {
  it.each([
    ['text/html, application/json;q=0.1', 'text/html'],
    ['text/markdown;q=0', 'text/html'],
    ['text/html;q=0.5, text/markdown;q=0.8', 'text/markdown'],
    ['text/*', 'text/markdown'],
    ['*/*', 'text/markdown'],
  ])('negotiates %s as %s', async (accept, expectedContentType) => {
    const request = new Request('https://varlock.dev/missing', { headers: { accept } });
    const response = await worker.fetch(request, createEnv(() => new Response('HTML', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    })));

    expect(response.headers.get('content-type')).toContain(expectedContentType);
  });

  it('does not forward HTML validators when generating Markdown', async () => {
    let assetRequest: Request | undefined;
    const request = new Request('https://varlock.dev/missing', {
      headers: {
        accept: 'text/markdown',
        'if-none-match': '"html-404"',
      },
    });
    const response = await worker.fetch(request, createEnv((receivedRequest) => {
      assetRequest = receivedRequest;
      return new Response('HTML', { status: 404 });
    }));

    expect(assetRequest?.headers.has('if-none-match')).toBe(false);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/markdown');
  });

  it('preserves HTML conditional requests', async () => {
    const request = new Request('https://varlock.dev/missing', {
      headers: {
        accept: 'text/html',
        'if-none-match': '"html-404"',
      },
    });
    const response = await worker.fetch(request, createEnv((receivedRequest) => {
      expect(receivedRequest.headers.get('if-none-match')).toBe('"html-404"');
      return new Response(null, { status: 304 });
    }));

    expect(response.status).toBe(304);
  });
});
