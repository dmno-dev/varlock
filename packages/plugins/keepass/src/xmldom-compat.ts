/**
 * Build-time stand-in for `@xmldom/xmldom`, wired up by the alias plugin in `tsdown.config.ts`.
 *
 * kdbxweb builds its parser with the `errorHandler` object that xmldom removed in 0.9, which
 * makes every `new DOMParser()` call throw `errorHandler object is no longer supported`.
 * kdbxweb has not shipped a release since 2021, so instead of holding the whole repo back on
 * xmldom 0.8, we hand it a DOMParser that translates the old option to the supported one.
 *
 * Everything else is re-exported untouched. `DOMParser` declared here shadows the star export.
 */
export * from '@xmldom/xmldom';

import { DOMParser as XmlDOMParser } from '@xmldom/xmldom';

type LegacyParserOptions = ConstructorParameters<typeof XmlDOMParser>[0] & {
  /** removed in xmldom 0.9, still passed by kdbxweb */
  errorHandler?: unknown;
};

export class DOMParser extends XmlDOMParser {
  constructor(options?: LegacyParserOptions) {
    const { errorHandler: _legacyErrorHandler, ...rest } = options ?? {};
    super({
      ...rest,
      // kdbxweb's handler threw on warnings, errors and fatal errors alike - keep that,
      // so malformed XML still fails loudly rather than parsing into a partial document
      onError: (_level, message) => { throw new Error(message); },
    });
  }
}
