import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { ENV } from 'varlock/env';
import { routeTree } from './routeTree.gen';

// Top-level ENV access in a statically-imported module.
// This runs at module evaluation time — before any request handler.
// If initVarlockEnv hasn't run yet, this will fail or return undefined.
const envCheckResult = {
  apiUrl: ENV.API_URL,
  hasSecret: ENV.SECRET_KEY ? 'yes' : 'no',
};

export function getEnvCheckResult() {
  return envCheckResult;
}

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
  });
  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
