/* eslint-disable no-console */
export function debug(...args: Array<any>) {
  if (!globalThis.process?.env.DEBUG_VARLOCK) return;
  console.log(...args);
}
