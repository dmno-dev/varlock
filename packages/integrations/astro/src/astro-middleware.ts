import { MiddlewareHandler } from 'astro';
import { scanForLeaks } from 'varlock/env';

export const onRequest: MiddlewareHandler = async (context, next) => {
  const response = await next();

  const contentType = response.headers.get('content-type');
  if (contentType?.startsWith('image/') || contentType?.startsWith('video/') || contentType?.startsWith('audio/')) {
    // other types to skip?
    return response;
  }


  const scannedBody = scanForLeaks(response.clone().body, {
    method: 'varlock astro middleware',
    file: context.url.toString(),
  });
  if (scannedBody === null) return response;
  return new Response(scannedBody, response);
};
