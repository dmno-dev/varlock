/*
  This patches the global ServerResponse object to scan for secret leaks - currently used for next.js and remix
*/

import zlib from 'node:zlib';
import { ServerResponse } from 'node:http';
import { redactSensitiveConfig, scanForLeaks, varlockSettings } from './env';
import { debug } from './lib/debug';

// NOTE - previously was using a symbol but got weird because of multiple builds and contexts...
const patchedKey = '_patchedByVarlock';
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

    // have to deal with compressed data, which is awkward but possible
    const compressionType = this.getHeader('Content-Encoding');
    let chunkStr;
    let chunkType: 'string' | 'encoded' | 'gzip' | null = null;
    if (typeof rawChunk === 'string') {
      chunkType = 'string';
      chunkStr = rawChunk;
    } else if (!compressionType) {
      chunkType = 'encoded';
      const decoder = new TextDecoder();
      chunkStr = decoder.decode(rawChunk);
    } else if (compressionType === 'gzip' || compressionType === 'deflate') {
      chunkType = 'gzip';
      // TODO: figure out how we can unzip one chunk at a time instead of storing everything
      (this as any)._zlibChunks ||= [];
      (this as any)._zlibChunks.push(rawChunk);
      // NOTE - we must attempt to decode from the very FIRST chunk: small responses
      // arrive as a single complete gzip chunk, so skipping it means never scanning
      // at all (and browsers always send Accept-Encoding: gzip). A genuinely partial
      // stream fails to decode here and gets scanned once more chunks arrive.
      try {
        const unzippedChunk = zlib.unzipSync(Buffer.concat((this as any)._zlibChunks || []), {
          flush: zlib.constants.Z_SYNC_FLUSH,
          finishFlush: zlib.constants.Z_SYNC_FLUSH,
        });
        const fullUnzippedData = unzippedChunk.toString('utf-8');
        chunkStr = fullUnzippedData.substring((this as any)._lastChunkEndIndex || 0);
        (this as any)._lastChunkEndIndex = fullUnzippedData.length;
      } catch (err) {
        // partial gzip data that doesn't decode yet — scanned when more chunks arrive
      }
    }
    // TODO: we may want to support other compression schemes? but currently only used in nextjs which is using gzip
    if (chunkStr) {
      // console.log('scanning!', chunkStr.substring(0, 1000));


      try {
        scanForLeaks(chunkStr, { method: 'patched ServerResponse.write', file: (this as any).req.url });
      } catch (err) {
        // console.log('found secret in chunk', chunkType, chunkStr);
        // console.log(this)
        if (opts?.redactInsteadOfThrow) {
          chunkStr = redactSensitiveConfig(chunkStr);
          if (chunkType === 'string') {
            args[0] = chunkStr;
          } else if (chunkType === 'encoded') {
            const encoder = new TextEncoder();
            args[0] = encoder.encode(chunkStr);
          } else if (chunkType === 'gzip') {
            // we can't reliably scrub inside a compressed stream (re-gzipping a single
            // chunk corrupts the stream state), so fail closed — killing the response
            // beats serving the secret, even in dev
            // TODO: pass chunks through our own gzip stream so we can scrub + re-encode
            throw err;
          } else {
            throw new Error(`unable to scrub - unknown chunk type ${chunkType}`);
          }
        } else {
          throw err;
        }
      }
    }

    // @ts-ignore
    return serverResponseWrite.apply(this, args);
  };

  // calling `res.json()` in the api routes on pages router calls `res.end` without called `res.write`
  const serverResponseEnd = ServerResponse.prototype.end;
  // @ts-ignore
  ServerResponse.prototype.end = function patchedServerResponseEnd(...args) {
    // console.log('⚡️ patched ServerResponse.end');
    const endChunk = args[0];
    // this just needs to work (so far) for nextjs sending json bodies, so does not need to handle all cases...
    if (endChunk && typeof endChunk === 'string') {
      // TODO: currently this throws the error and then things just hang... do we want to try to return an error type response instead?
      scanForLeaks(endChunk, { method: 'patched ServerResponse.end' });
    }
    // @ts-ignore
    return serverResponseEnd.apply(this, args);
  };
}

