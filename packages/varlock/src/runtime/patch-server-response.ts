/*
  This patches the global ServerResponse object to scan for secret leaks - currently used for next.js and remix
*/

import zlib from 'node:zlib';
import { ServerResponse } from 'node:http';
import {
  getRedactionHoldbackLength, redactSensitiveConfig, scanForLeaks, varlockSettings,
} from './env';
import { debug } from './lib/debug';

// NOTE - previously was using a symbol but got weird because of multiple builds and contexts...
const patchedKey = '_patchedByVarlock';

/**
 * How long to hold back a possible partial secret before writing it out anyway. Chunks that
 * split a secret arrive back-to-back in practice, so this only fires when a response genuinely
 * pauses right after emitting something that looks like the start of a secret (e.g. SSE) -
 * without it, that trailing text would sit unsent until the next chunk or `end()`.
 */
const PENDING_FLUSH_TIMEOUT_MS = 100;

/**
 * Returns a sync decompressor for a Content-Encoding value, or undefined if unsupported.
 * Each decompressor must tolerate truncated input (returning whatever prefix is decodable,
 * or throwing) so responses can be scanned incrementally as chunks arrive.
 */
function getDecompressor(encoding: string): ((buf: Buffer) => Buffer) | undefined {
  if (encoding === 'gzip' || encoding === 'deflate') {
    return (buf) => zlib.unzipSync(buf, {
      flush: zlib.constants.Z_SYNC_FLUSH,
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
    });
  }
  if (encoding === 'br') {
    return (buf) => zlib.brotliDecompressSync(buf, {
      flush: zlib.constants.BROTLI_OPERATION_FLUSH,
      finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
    });
  }
  // zstd support requires node >= 22.15 — truncated input yields partial
  // (usually empty) output rather than throwing, which the delta tracking handles
  if (encoding === 'zstd' && typeof (zlib as any).zstdDecompressSync === 'function') {
    return (buf) => (zlib as any).zstdDecompressSync(buf);
  }
  return undefined;
}

/**
 * Per-response scanning state. A sensitive value can be split across `write()` calls (streaming
 * SSR flushes at arbitrary boundaries) or across a final `write()` and `end()`, and the scanner
 * matches complete values only - so each scan has to see a little of what came before it.
 */
type ScanState = {
  /** decoded text that was scanned but is being withheld from the response, because it looks
   * like the start of a sensitive value and the rest may arrive in the next chunk */
  pending: string,
  /** decoded text already sent, retained only so the next scan can match across the boundary */
  carry: string,
  /** streaming decoder, so a multi-byte character split across chunks doesn't decode to garbage
   * (created lazily - responses that never hit the binary path don't need one) */
  decoder: TextDecoder | undefined,
  zlibChunks: Array<Buffer>,
  /** streaming decoder for decompressed deltas, which may end inside a multi-byte character */
  decompressedDecoder: TextDecoder | undefined,
  /** byte length of the decompressed output already scanned, so each chunk only scans new bytes */
  decompressedLength: number,
  flushTimer: ReturnType<typeof setTimeout> | undefined,
};

function getScanState(res: any): ScanState {
  res._varlockScanState ||= {
    pending: '',
    carry: '',
    decoder: undefined,
    zlibChunks: [],
    decompressedDecoder: undefined,
    decompressedLength: 0,
    flushTimer: undefined,
  } satisfies ScanState;
  return res._varlockScanState;
}

/** decodes binary chunks in stream mode, holding an incomplete multi-byte char until the rest
 * of it arrives - passing no chunk flushes whatever is still held (as a replacement char) */
function decodeChunk(state: ScanState, chunk?: Uint8Array, isFinal?: boolean) {
  if (!chunk && !state.decoder) return '';
  state.decoder ||= new TextDecoder();
  if (!chunk) return state.decoder.decode();
  return state.decoder.decode(chunk, { stream: !isFinal });
}

function decodeDecompressedDelta(state: ScanState, decompressed: Buffer, isFinal = false) {
  state.decompressedDecoder ||= new TextDecoder();
  const delta = decompressed.subarray(state.decompressedLength);
  state.decompressedLength = decompressed.byteLength;
  return state.decompressedDecoder.decode(delta, { stream: !isFinal });
}

function clearPendingFlush(state: ScanState) {
  if (state.flushTimer !== undefined) {
    clearTimeout(state.flushTimer);
    state.flushTimer = undefined;
  }
}

/**
 * Scans `chunkStr` together with whatever was withheld or retained from previous chunks, and
 * returns the text that should actually go out. When `canHoldBack` is set, a trailing partial
 * match of a sensitive value is withheld (moved to `state.pending`) so a value split across the
 * boundary can still be redacted rather than half-sent.
 */
function scanChunk(state: ScanState, chunkStr: string, o: {
  canHoldBack: boolean,
  redactInsteadOfThrow?: boolean,
  meta: { method: string, file?: string },
}): string {
  let emitPart = state.pending + chunkStr;
  try {
    scanForLeaks(state.carry + emitPart, o.meta);
  } catch (err) {
    if (!o.redactInsteadOfThrow) throw err;
    emitPart = redactSensitiveConfig(emitPart);
    // a value straddling `carry` is partly out the door already and can't be scrubbed
    // retroactively, so anything still detectable after redaction fails closed
    scanForLeaks(state.carry + emitPart, o.meta);
  }

  // only what is still in hand can be withheld - anything already sent is capped out
  const holdbackLength = o.canHoldBack
    ? Math.min(getRedactionHoldbackLength(state.carry + emitPart), emitPart.length)
    : 0;
  state.pending = holdbackLength ? emitPart.slice(-holdbackLength) : '';
  const emit = holdbackLength ? emitPart.slice(0, -holdbackLength) : emitPart;

  // retain any sent text still needed to span the next boundary (what `pending` doesn't cover)
  const sent = state.carry + emit;
  const carryLength = Math.max(0, getRedactionHoldbackLength(sent + state.pending) - state.pending.length);
  state.carry = carryLength ? sent.slice(-carryLength) : '';

  return emit;
}

export function patchGlobalServerResponse(opts?: {
  ignoreUrlPatterns?: Array<RegExp>,
  redactInsteadOfThrow?: boolean,
}) {
  debug('⚡️ PATCHING global ServerResponse');
  if (Object.getOwnPropertyDescriptor(ServerResponse.prototype, patchedKey)) {
    debug('> already patched');
    return;
  }
  if (varlockSettings.preventLeaks === false) {
    debug('> disabled by settings');
    return;
  }

  Object.defineProperty(ServerResponse.prototype, patchedKey, { value: true });

  const serverResponseWrite = ServerResponse.prototype.write;

  function schedulePendingFlush(res: any, state: ScanState) {
    clearPendingFlush(state);
    if (!state.pending) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined;
      const text = state.pending;
      state.pending = '';
      if (!text || res.writableEnded || res.destroyed) return;
      // it's going out unscrubbed now, so keep it in `carry` for the next scan
      const sent = state.carry + text;
      const carryLength = getRedactionHoldbackLength(sent);
      state.carry = carryLength ? sent.slice(-carryLength) : '';
      (serverResponseWrite as any).call(res, text);
    }, PENDING_FLUSH_TIMEOUT_MS);
    // don't let a pending flush keep the process alive
    state.flushTimer.unref?.();
  }

  // @ts-ignore
  ServerResponse.prototype.write = function varlockPatchedServerResponseWrite(...args) {
    // TODO: do we want to filter out some requests here? maybe based on the file type?

    const rawChunk = args[0];
    // console.log('⚡️ patched ServerResponse.write', rawChunk);

    // for now, we only scan rendered html... may need to change this though for server components?
    // so we bail if it looks like this response does not contain html
    const contentType = this.getHeader('content-type')?.toString() || '';
    // console.log('patched ServerResponse.write', contentType);
    let runScan = (
      contentType.startsWith('text/')
      || contentType.startsWith('application/json')
      || (!contentType && typeof rawChunk === 'string')
      // || contentType.startsWith('application/javascript')
    );

    const reqUrl = (this as any).req.url;
    // console.log('> scan ServerResponse.write', contentType, reqUrl);
    if (runScan && reqUrl && opts?.ignoreUrlPatterns?.some((pattern) => pattern.test(reqUrl))) {
      runScan = false;
    }

    // we want to run the scanner on text/html and text/x-component (server actions)
    // TODO: anything else?
    if (!runScan) {
      // @ts-ignore
      return serverResponseWrite.apply(this, args);
    }

    const state = getScanState(this);
    clearPendingFlush(state);

    // A later chunk may be redacted to a different length. Once write() sends the
    // headers, Content-Length cannot be corrected, so use chunked framing instead.
    if (opts?.redactInsteadOfThrow && !this.headersSent && this.getHeader('content-length') !== undefined) {
      this.removeHeader('content-length');
    }

    // have to deal with compressed data, which is awkward but possible
    const compressionType = this.getHeader('Content-Encoding');
    let chunkStr;
    let chunkType: 'string' | 'encoded' | 'compressed' | null = null;
    if (typeof rawChunk === 'string') {
      chunkType = 'string';
      chunkStr = rawChunk;
    } else if (!compressionType) {
      chunkType = 'encoded';
      chunkStr = decodeChunk(state, rawChunk);
    } else {
      const decompress = getDecompressor(String(compressionType).toLowerCase());
      if (decompress) {
        chunkType = 'compressed';
        // TODO: figure out how we can decompress one chunk at a time instead of storing everything
        state.zlibChunks.push(rawChunk);
        // NOTE - we must attempt to decode from the very FIRST chunk: small responses
        // arrive as a single complete compressed chunk, so skipping it means never
        // scanning at all (and browsers always send Accept-Encoding: gzip). A genuinely
        // partial stream fails to decode here and gets scanned once more chunks arrive.
        try {
          const decompressedChunk = decompress(Buffer.concat(state.zlibChunks));
          chunkStr = decodeDecompressedDelta(state, decompressedChunk);
        } catch (err) {
          // partial compressed data that doesn't decode yet — scanned when more chunks arrive
        }
      } else {
        // no decompressor for this encoding — response cannot be scanned (fails open)
        debug(`⚠️ leak scan skipped - unsupported content-encoding: ${compressionType}`);
      }
    }

    if (chunkStr !== undefined && chunkType) {
      // console.log('scanning!', chunkStr.substring(0, 1000));

      // a string written with an explicit non-utf8 encoding can't be sliced or re-encoded
      // safely (e.g. splitting base64 mid-quantum), so it is scanned but never withheld
      const encodingArg = typeof args[1] === 'string' ? args[1] : undefined;
      const canHoldBack = chunkType === 'encoded' || !encodingArg || /^utf-?8$/i.test(encodingArg);

      if (chunkType === 'compressed') {
        // we can't reliably scrub or withhold anything inside a compressed stream (re-compressing
        // a single chunk corrupts the stream state), so fail closed even in redact mode:
        // killing the response beats serving the secret
        // TODO: pass chunks through our own compression stream so we can scrub + re-encode
        scanChunk(state, chunkStr, {
          canHoldBack: false,
          meta: { method: 'patched ServerResponse.write', file: reqUrl },
        });
      } else {
        const emit = scanChunk(state, chunkStr, {
          canHoldBack,
          redactInsteadOfThrow: opts?.redactInsteadOfThrow,
          meta: { method: 'patched ServerResponse.write', file: reqUrl },
        });
        // when nothing was redacted or withheld we pass the original chunk straight
        // through, so a clean response stays byte-for-byte identical
        if (emit !== chunkStr) {
          if (!emit) {
            // the whole chunk is being withheld - report it as written and fire the
            // write callback, since it will go out with the next chunk (or on flush)
            const cb = args.find((arg: any) => typeof arg === 'function');
            if (cb) process.nextTick(cb);
            schedulePendingFlush(this, state);
            return true;
          }
          args[0] = chunkType === 'encoded' ? new TextEncoder().encode(emit) : emit;
        }
      }
    }

    schedulePendingFlush(this, state);

    // @ts-ignore
    return serverResponseWrite.apply(this, args);
  };

  // calling `res.json()` in the api routes on pages router calls `res.end` without called `res.write`
  const serverResponseEnd = ServerResponse.prototype.end;
  // @ts-ignore
  ServerResponse.prototype.end = function patchedServerResponseEnd(...args) {
    // console.log('⚡️ patched ServerResponse.end');
    const endChunk = args[0];
    const state = getScanState(this);
    clearPendingFlush(state);

    // this just needs to work (so far) for nextjs sending json bodies, so does not need to handle all cases...
    const compressionType = this.getHeader('Content-Encoding');
    const isBinaryChunk = !!endChunk && (Buffer.isBuffer(endChunk) || endChunk instanceof Uint8Array);
    let chunkStr: string | undefined;

    if (isBinaryChunk && compressionType) {
      const decompress = getDecompressor(String(compressionType).toLowerCase());
      let decompressed: Buffer | undefined;
      if (decompress) {
        state.zlibChunks.push(endChunk as Buffer);
        try {
          decompressed = decompress(Buffer.concat(state.zlibChunks));
        } catch (err) {
          // stream didn't decode, nothing more we can do at this point
        }
      }
      if (decompressed !== undefined) {
        // compressed output can't be scrubbed, so a detected leak always throws (see write above)
        scanForLeaks(state.carry + decodeDecompressedDelta(state, decompressed, true), {
          method: 'patched ServerResponse.end',
          file: (this as any).req?.url,
        });
      }
      // @ts-ignore
      return serverResponseEnd.apply(this, args);
    }

    if (endChunk && typeof endChunk === 'string') {
      // any bytes the streaming decoder is still holding came before this chunk
      chunkStr = decodeChunk(state) + endChunk;
    } else if (isBinaryChunk) {
      // decode Buffer/Uint8Array like write does when uncompressed (final decode, so
      // a trailing incomplete char is flushed rather than held)
      chunkStr = decodeChunk(state, endChunk as Uint8Array, true);
    } else {
      // no body chunk (`end()` / `end(cb)`) - still need to flush anything withheld
      chunkStr = decodeChunk(state);
    }

    if (chunkStr || state.pending) {
      // last chunk, so nothing can be withheld for later - it all goes out now
      const emit = scanChunk(state, chunkStr, {
        canHoldBack: false,
        redactInsteadOfThrow: opts?.redactInsteadOfThrow,
        meta: { method: 'patched ServerResponse.end', file: (this as any).req?.url },
      });
      if (emit !== chunkStr) {
        if (typeof endChunk === 'string') {
          args[0] = emit;
        } else if (isBinaryChunk) {
          args[0] = new TextEncoder().encode(emit);
        } else {
          // `end()` or `end(cb)` becomes `end(text)` / `end(text, cb)`
          args.unshift(emit);
        }
        // redaction changes the body length, and frameworks do set Content-Length for
        // bodies sent in a single `end()` call (next.js does for non-streamed payloads).
        // Leaving the original length would hang the client waiting on bytes never sent.
        if (!this.headersSent && this.getHeader('content-length') !== undefined) {
          this.setHeader('content-length', Buffer.byteLength(emit));
        }
      }
    }

    // @ts-ignore
    return serverResponseEnd.apply(this, args);
  };
}
