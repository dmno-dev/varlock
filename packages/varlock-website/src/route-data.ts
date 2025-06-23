import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

export const onRequest = defineRouteMiddleware((context) => {
  // Get the URL of the generated image for the current page using its ID and
  // append the `.png` file extension.
  let ogImageUrl = new URL(
    `/og-images/${context.locals.starlightRoute.id || 'index'}.png`,
    context.site,
  );

  if (!context.locals.starlightRoute.id) {
    ogImageUrl = new URL('/default-og-image.png', context.site);
  }

  // Get the array of all tags to include in the `<head>` of the current page.
  const { head } = context.locals.starlightRoute;

  // Add the `<meta/>` tags for the Open Graph images.
  head.push({
    tag: 'meta',
    attrs: { property: 'og:image', content: ogImageUrl.href },
  });
  head.push({
    tag: 'meta',
    attrs: { name: 'twitter:image', content: ogImageUrl.href },
  });
});
