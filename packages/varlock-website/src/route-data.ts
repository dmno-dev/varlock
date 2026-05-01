import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { createMetaHead } from './lib/meta';

const DEFAULT_DESCRIPTION = 'AI-safe .env files: schemas for agents, secrets for humans. Validate, secure, and share environment variables with type-safety and leak prevention.';

export const onRequest = defineRouteMiddleware((context) => {
  const { head, entry, siteTitle } = context.locals.starlightRoute;
  const title = entry?.data?.title
    ? `${entry.data.title} | ${siteTitle}`
    : siteTitle;
  const description = (entry?.data?.description as string | undefined) ?? DEFAULT_DESCRIPTION;
  const pageUrl = new URL(context.url.pathname, context.site).href;

  let ogImageUrl = new URL(
    `/og-images/${context.locals.starlightRoute.id || 'index'}.png`,
    context.site,
  );
  if (!context.locals.starlightRoute.id) {
    ogImageUrl = new URL('/default-og-image-new.png', context.site);
  }

  head.push(
    ...createMetaHead({
      title,
      description,
      url: pageUrl,
      ogImageUrl: ogImageUrl.href,
    }),
  );
});
