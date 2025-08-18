declare const Deno: any;
declare const navigator: any;
declare const window: any;
declare const self: any;
// declare const process: any;


export const isNode: boolean = typeof process !== 'undefined'
  && process.versions != null
  && process.versions.node != null;

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
export const isBun = typeof process !== 'undefined' && process.versions != null && process.versions.bun != null;



export const isBrowser = typeof window !== 'undefined'
  && typeof window.document !== 'undefined'
  && typeof window.document.createElement === 'function'
  && typeof navigator !== 'undefined'
  && typeof navigator.userAgent === 'string';
