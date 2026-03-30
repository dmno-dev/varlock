/**
 * Shared mutable plugin context used during plugin module execution.
 *
 * Kept in its own file to avoid a circular dependency between plugins.ts
 * (which sets the active plugin) and plugin-lib.ts (which exposes it to
 * plugin authors) — both of which would otherwise need to import each other.
 *
 * plugins.ts calls activatePlugin / deactivatePlugin around each load.
 * plugin-lib.ts re-exports `plugin` as a Proxy that delegates to whatever
 * is currently active.
 */


const ctx: { active: any } = { active: undefined };

export function activatePlugin(p: unknown): void {
  ctx.active = p;
}

export function deactivatePlugin(): void {
  ctx.active = undefined;
}

/**
 * A proxy that always delegates to the currently-loading plugin instance.
 * Plugin code can import this and use it as if it were the plugin directly.
 *
 * Valid only between activatePlugin() and deactivatePlugin() calls.
 */

export const pluginProxy: any = new Proxy({} as any, {
  get(_, key) {
    if (!ctx.active) throw new Error('[varlock] No active plugin context — are you importing plugin-lib outside of a plugin module?');
    const val = ctx.active[key];
    return typeof val === 'function' ? val.bind(ctx.active) : val;
  },
  set(_, key, value) {
    if (!ctx.active) throw new Error('[varlock] No active plugin context');
    ctx.active[key] = value;
    return true;
  },
});
