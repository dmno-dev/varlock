/* eslint-disable no-console */
export function debug(...args: Array<any>) {
  if (!process.env.DEBUG_VARLOCK) return;
  console.log(...args);
}
