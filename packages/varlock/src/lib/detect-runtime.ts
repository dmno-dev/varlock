declare const Deno: any;
declare const navigator: any;
declare const window: any;
declare const self: any;
// declare const process: any;


let versionsStr = 'versions'; // eslint-disable-line
// we use a string here so nextjs static analysis doesnt get angry
const processVersions = typeof process !== 'undefined' && (process as any)[versionsStr as any]; // @ts-ignore

export const isNode: boolean = processVersions && processVersions.node != null;

export const isWebWorker: boolean = typeof self === 'object'
  && self.constructor
  && self.constructor.name === 'DedicatedWorkerGlobalScope';

// https://github.com/jsdom/jsdom/issues/1537#issuecomment-229405327
export const isJsDom: boolean = (typeof window !== 'undefined' && window.name === 'nodejs')
  || (typeof navigator !== 'undefined'
    && 'userAgent' in navigator
    && typeof navigator.userAgent === 'string'
    && (navigator.userAgent.includes('Node.js')
      || navigator.userAgent.includes('jsdom')));

export const isDeno: boolean = typeof Deno !== 'undefined'
  && typeof Deno.version !== 'undefined'
  && typeof Deno.version.deno !== 'undefined';

/** @see {@link https://bun.sh/guides/util/detect-bun} */
export const isBun = processVersions && processVersions.bun != null;



export const isBrowser = typeof window !== 'undefined'
  && typeof window.document !== 'undefined'
  && typeof window.document.createElement === 'function'
  && typeof navigator !== 'undefined'
  && typeof navigator.userAgent === 'string';
