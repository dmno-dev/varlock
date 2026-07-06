import { NextResponse } from 'next/server';
import { ENV } from 'varlock/env';

// only run for a dedicated test path so other routes are unaffected
export const config = { matcher: '/middleware-test' };

// middleware always runs in the edge runtime
export function middleware() {
  return NextResponse.json({
    title: 'varlock-middleware-response',
    nextPrefixedVar: ENV.NEXT_PUBLIC_VAR,
    publicVar: ENV.PUBLIC_VAR,
    envSpecificVar: ENV.ENV_SPECIFIC_VAR,
    hasSensitive: ENV.SENSITIVE_VAR ? 'middleware-sensitive-available' : 'X - not available',
  });
}
