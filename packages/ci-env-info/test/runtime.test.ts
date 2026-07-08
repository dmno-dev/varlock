import { describe, expect, it } from 'vitest';
import { detectOs, detectRuntime } from '../src/runtime';

describe('detectRuntime', () => {
  it('detects node', () => {
    const info = detectRuntime({ process: { versions: { node: '22.0.0' } } });
    expect(info).toMatchObject({ runtime: 'node', isNode: true });
  });

  it('detects bun via globalThis.Bun', () => {
    const info = detectRuntime({ Bun: {}, process: { versions: { bun: '1.1.0' } } });
    expect(info).toMatchObject({ runtime: 'bun', isBun: true, isNode: false });
  });

  it('detects deno and takes priority over node-like process', () => {
    const info = detectRuntime({ Deno: {}, process: { versions: { node: '22.0.0' } } });
    expect(info).toMatchObject({ runtime: 'deno', isDeno: true, isNode: false });
  });

  it('detects Cloudflare Workers (workerd) via navigator.userAgent', () => {
    const info = detectRuntime({ navigator: { userAgent: 'Cloudflare-Workers' } });
    expect(info).toMatchObject({ runtime: 'workerd', isWorkerd: true });
  });

  it('detects edge-light via globalThis.EdgeRuntime', () => {
    const info = detectRuntime({ EdgeRuntime: 'vercel' });
    expect(info).toMatchObject({ runtime: 'edge-light', isEdgeLight: true });
  });

  it('detects browser via window + document', () => {
    const info = detectRuntime({ window: {}, document: {} });
    expect(info).toMatchObject({ runtime: 'browser', isBrowser: true });
  });

  it('returns undefined runtime when nothing matches', () => {
    const info = detectRuntime({});
    expect(info.runtime).toBeUndefined();
  });
});

describe('detectOs', () => {
  it('detects macOS', () => {
    expect(detectOs({ platform: 'darwin' })).toMatchObject({ isMac: true, isWindows: false, isLinux: false });
  });

  it('detects Windows', () => {
    expect(detectOs({ platform: 'win32' })).toMatchObject({ isMac: false, isWindows: true, isLinux: false });
  });

  it('detects Linux', () => {
    expect(detectOs({ platform: 'linux' })).toMatchObject({ isMac: false, isWindows: false, isLinux: true });
  });

  it('returns all-false when process is unavailable', () => {
    expect(detectOs({})).toMatchObject({
      platform: undefined, isMac: false, isWindows: false, isLinux: false,
    });
  });
});
