// Make the route fully static — exercises the Cloudflare adapter + varlock's
// injected edge loader in a prerender-only ("totally static") build, where the
// loader must be a no-op in Node at build time.
export const prerender = true;
