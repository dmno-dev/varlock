/* eslint-disable no-console */

import { format } from 'node:util';

/**
 * Debug logger with colors, timing, and format string support
 * Enable by setting DEBUG env var with namespaces (e.g., DEBUG=varlock:*)
 */

type DebugFn = (...args: Array<any>) => void;

// Track last call time per namespace for diff timing
const prevTime = new Map<string, number>();

// ANSI color codes
const colors = [
  '\x1b[36m', // cyan
  '\x1b[35m', // magenta
  '\x1b[34m', // blue
  '\x1b[33m', // yellow
  '\x1b[32m', // green
  '\x1b[31m', // red
  '\x1b[96m', // bright cyan
  '\x1b[95m', // bright magenta
  '\x1b[94m', // bright blue
  '\x1b[93m', // bright yellow
  '\x1b[92m', // bright green
  '\x1b[91m', // bright red
];
const resetCode = '\x1b[0m';
const grayCode = '\x1b[90m';

// Simple hash function to deterministically assign colors
const selectColor = (namespace: string): string => {
  let hash = 0;
  for (let i = 0; i < namespace.length; i++) {
    // eslint-disable-next-line no-bitwise
    hash = ((hash << 5) - hash) + namespace.charCodeAt(i);
    // eslint-disable-next-line no-bitwise
    hash |= 0; // Convert to 32bit integer
  }
  return colors[Math.abs(hash) % colors.length];
};

// Format milliseconds in human-readable form
const humanizeMs = (ms: number): string => {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
};

const isEnabled = (namespace: string): boolean => {
  const debugEnv = process.env.DEBUG || '';
  if (!debugEnv) return false;

  const patterns = debugEnv.split(',').map((p) => p.trim());
  let enabled = false;

  for (const pattern of patterns) {
    // Negative pattern (exclude)
    if (pattern.startsWith('-')) {
      const excludePattern = pattern.slice(1);
      if (excludePattern === namespace) return false;
      if (excludePattern.endsWith('*')) {
        const prefix = excludePattern.slice(0, -1);
        if (namespace.startsWith(prefix)) return false;
      }
      continue;
    }

    // Positive pattern (include)
    if (pattern === '*') {
      enabled = true;
    } else if (pattern === namespace) {
      enabled = true;
    } else if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      if (namespace.startsWith(prefix)) {
        enabled = true;
      }
    }
  }

  return enabled;
};

export function createDebug(namespace: string): DebugFn {
  const enabled = isEnabled(namespace);

  if (!enabled) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return () => {};
  }

  const colorCode = selectColor(namespace);

  return (...args: Array<any>) => {
    const now = Date.now();
    const prev = prevTime.get(namespace);
    const diff = prev ? now - prev : 0;
    prevTime.set(namespace, now);

    // Format the message with util.format for printf-style formatting
    const msg = format(...args);

    // Build the output with colored namespace and diff timing
    const diffStr = diff > 0 ? `${grayCode} +${humanizeMs(diff)}${resetCode}` : '';
    const output = `${colorCode}${namespace}${resetCode} ${msg}${diffStr}`;

    console.error(output);
  };
}

export type Debugger = ReturnType<typeof createDebug>;
