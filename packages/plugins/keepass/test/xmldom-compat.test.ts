import { describe, test, expect } from 'vitest';
import { DOMParser, XMLSerializer } from '../src/xmldom-compat';

// The keepass suite covers this end to end (it opens real databases through the built bundle),
// but these pin the wrapper's own contract, since the whole point is compatibility with an
// option shape kdbxweb passes and xmldom no longer accepts.
describe('xmldom compat wrapper', () => {
  test('accepts the legacy errorHandler object kdbxweb passes', () => {
    const parser = new DOMParser({
      errorHandler: {
        warning: (e: Error) => { throw e; },
        error: (e: Error) => { throw e; },
        fatalError: (e: Error) => { throw e; },
      },
    } as any);
    const doc = parser.parseFromString('<KeePassFile><Root /></KeePassFile>', 'application/xml');
    expect(doc.documentElement?.nodeName).toEqual('KeePassFile');
  });

  test('works with no options at all', () => {
    const doc = new DOMParser().parseFromString('<a>hi</a>', 'application/xml');
    expect(doc.documentElement?.textContent).toEqual('hi');
  });

  test('throws on malformed xml rather than returning a partial document', () => {
    // xmldom's default handler only throws on fatal errors - these two are reported at lower
    // levels and would otherwise parse into a document that silently lost data, so they only
    // fail if the strict onError is actually wired up
    expect(() => {
      new DOMParser().parseFromString('<a>&undefined_entity;</a>', 'application/xml');
    }).toThrow();
    expect(() => {
      new DOMParser().parseFromString('<a b=unquoted />', 'application/xml');
    }).toThrow();
  });

  test('re-exports the rest of xmldom', () => {
    const doc = new DOMParser().parseFromString('<a b="c" />', 'application/xml');
    expect(new XMLSerializer().serializeToString(doc)).toEqual('<a b="c"/>');
  });
});
