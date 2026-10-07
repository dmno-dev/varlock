/*
  Randomized check of both streaming redactors against a single-shot oracle.

  A tiny alphabet makes secrets overlap each other (and themselves) constantly, which is where
  every bug in this code has lived: holdback cutting through a complete value, a complete value
  inside already-written text hiding an overlapping one that extends into the next chunk, etc.
  Seeds are fixed, so a failure replays exactly.
*/
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { redactSensitiveConfig, resetRedactionMap } from '../env';
import { createRedactedStreamWriter, FLUSH_TIMEOUT_MS } from '../lib/redact-stream';
import { patchStreamWrite, unpatchStreamWrite } from '../patch-process-streams';
import { makeRand } from './fuzz-helpers';
import type { SerializedEnvGraph } from '../../env-graph';

const ALPHABET = 'ab';
const ROUNDS = 1000;

type Secret = { value: string, redact?: false };

function randStr(rand: () => number, length: number, alphabet = ALPHABET) {
  return Array.from({ length }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
}

/** 1-4 secrets of 3-7 chars, some exempt from log redaction; dedupes by value */
function randSecrets(rand: () => number): Array<Secret> {
  const byValue = new Map<string, Secret>();
  for (let i = 0, n = 1 + Math.floor(rand() * 4); i < n; i++) {
    const value = randStr(rand, 3 + Math.floor(rand() * 5));
    const existing = byValue.get(value);
    // an exempt duplicate of a protected value stays protected (see resetRedactionMap)
    const exempt = rand() < 0.25 && !existing;
    byValue.set(value, exempt ? { value, redact: false } : { value });
  }
  return [...byValue.values()];
}

function setSecrets(secrets: Array<Secret>) {
  resetRedactionMap({
    config: Object.fromEntries(secrets.map((s, i) => [`K${i}`, { isSensitive: true, ...s }])),
  } as unknown as SerializedEnvGraph);
}

/**
 * text that is mostly secrets, glued with fragments of secrets (so occurrences overlap and
 * chunk boundaries land inside lookalikes), short random filler and newlines
 */
function randText(rand: () => number, secrets: Array<Secret>) {
  const pick = () => secrets[Math.floor(rand() * secrets.length)].value;
  let text = '';
  for (let i = 0, n = 1 + Math.floor(rand() * 8); i < n; i++) {
    const r = rand();
    if (r < 0.5) text += pick();
    else if (r < 0.7) text += pick().slice(0, 1 + Math.floor(rand() * 4)); // a prefix
    else if (r < 0.85) text += pick().slice(-(1 + Math.floor(rand() * 4))); // a suffix
    else if (r < 0.95) text += randStr(rand, Math.floor(rand() * 4));
    else text += '\n';
  }
  return text;
}

function randChunks(rand: () => number, text: string): Array<string> {
  const chunks: Array<string> = [];
  for (let i = 0; i < text.length;) {
    const take = 1 + Math.floor(rand() * 6);
    chunks.push(text.slice(i, i + take));
    i += take;
  }
  return chunks;
}

/** a stream that records what reaches it */
function recordingStream(out: Array<string>) {
  return {
    isTTY: false,
    write(chunk: any) {
      out.push(String(chunk));
      return true;
    },
  };
}

function protectedValues(secrets: Array<Secret>) {
  return secrets.filter((s) => s.redact !== false).map((s) => s.value);
}

/** every protected value that appears in `output` (redaction leaves only `xx▒▒▒▒▒`, so any hit is raw) */
function leaked(output: string, secrets: Array<Secret>) {
  return protectedValues(secrets).filter((v) => output.includes(v));
}

describe('streaming redaction fuzz', () => {
  describe('varlock run writer (holdback)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('matches single-shot redaction exactly when chunks arrive back to back', () => {
      const rand = makeRand(7);
      for (let round = 0; round < ROUNDS; round++) {
        const secrets = randSecrets(rand);
        setSecrets(secrets);
        const text = randText(rand, secrets);
        const chunks = randChunks(rand, text);
        const out: Array<string> = [];
        const writer = createRedactedStreamWriter({ write: (c: string) => out.push(c) });
        for (const chunk of chunks) writer.write(chunk);
        writer.flush();
        expect(out.join(''), JSON.stringify({ round, secrets, chunks })).toBe(redactSensitiveConfig(text));
      }
    });

    it('never emits a protected value even when the flush timeout fires between chunks', () => {
      const rand = makeRand(11);
      for (let round = 0; round < ROUNDS; round++) {
        const secrets = randSecrets(rand);
        setSecrets(secrets);
        const text = randText(rand, secrets);
        const chunks = randChunks(rand, text);
        const out: Array<string> = [];
        const writer = createRedactedStreamWriter(
          { write: (c: string) => out.push(c) },
          { onSplitValue: () => undefined },
        );
        for (const chunk of chunks) {
          writer.write(chunk);
          // a child that pauses mid-value: held text is flushed raw and remembered as carry
          if (rand() < 0.3) vi.advanceTimersByTime(FLUSH_TIMEOUT_MS + 1);
        }
        writer.flush();
        expect(leaked(out.join(''), secrets), JSON.stringify({ round, secrets, chunks })).toEqual([]);
      }
    });
  });

  describe('in-process stream patch (no holdback)', () => {
    const SPLIT_WARNED_KEY = Symbol.for('varlock.splitValueWarned');
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
      warn.mockRestore();
      delete (globalThis as any)[SPLIT_WARNED_KEY];
    });

    it('never emits a protected value, however the writes are split', () => {
      const rand = makeRand(13);
      for (let round = 0; round < ROUNDS; round++) {
        const secrets = randSecrets(rand);
        setSecrets(secrets);
        const text = randText(rand, secrets);
        const chunks = randChunks(rand, text);
        const out: Array<string> = [];
        const stream = recordingStream(out);
        patchStreamWrite(stream);
        for (const chunk of chunks) stream.write(chunk);
        unpatchStreamWrite(stream);
        expect(leaked(out.join(''), secrets), JSON.stringify({ round, secrets, chunks })).toEqual([]);
      }
    });

    it('matches single-shot redaction when the whole text is one write', () => {
      const rand = makeRand(17);
      for (let round = 0; round < ROUNDS; round++) {
        const secrets = randSecrets(rand);
        setSecrets(secrets);
        const text = randText(rand, secrets);
        const out: Array<string> = [];
        const stream = recordingStream(out);
        patchStreamWrite(stream);
        stream.write(text);
        unpatchStreamWrite(stream);
        expect(out.join(''), JSON.stringify({ round, secrets, text })).toBe(redactSensitiveConfig(text));
      }
    });
  });
});
