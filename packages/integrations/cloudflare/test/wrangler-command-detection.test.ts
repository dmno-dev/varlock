import {
  describe, expect, it,
} from 'vitest';
import { isPreviewDeployCommand } from '../src/wrangler-command-detection';

describe('isPreviewDeployCommand', () => {
  it.each([
    ['preview', '--help'],
    ['preview', '-h'],
    ['preview', '--config', 'wrangler.jsonc', 'settings', '--help'],
    ['preview', '--config=wrangler.jsonc', 'delete'],
    ['preview', '-c', 'wrangler.jsonc', 'secret', 'list'],
    ['preview', '--env', 'staging', 'base-config', 'secret', 'list'],
  ])('passes through non-deploying invocation %j', (...args) => {
    expect(isPreviewDeployCommand(args)).toBe(false);
  });

  it.each([
    ['preview'],
    ['preview', 'src/index.ts'],
    ['preview', '--config', 'wrangler.jsonc'],
    ['preview', '--config=wrangler.jsonc', 'src/index.ts'],
  ])('routes deployment invocation %j through varlock', (...args) => {
    expect(isPreviewDeployCommand(args)).toBe(true);
  });
});
