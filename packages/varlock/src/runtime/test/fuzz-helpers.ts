/*
  Deterministic fuzz helpers for the response scanner tests: given a seed, produce a
  reproducible random chunking of a text fixture so any failure can be replayed exactly.
*/

/** small deterministic PRNG (LCG) - no Math.random, so failures are reproducible by seed */
export function makeRand(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * Splits `text` into randomized write() chunks mixing string and Buffer pieces. String
 * pieces always break at character boundaries; Buffer pieces may be split further at
 * arbitrary byte offsets (including mid-character), but only between adjacent Buffers,
 * matching what a real byte stream can produce.
 */
export function randomChunks(text: string, rand: () => number): Array<string | Buffer> {
  const chars = Array.from(text);
  const chunks: Array<string | Buffer> = [];
  let i = 0;
  while (i < chars.length) {
    const take = 1 + Math.floor(rand() * 8);
    const piece = chars.slice(i, i + take).join('');
    i += take;
    if (rand() < 0.5) {
      chunks.push(piece);
    } else {
      let buf = Buffer.from(piece);
      while (buf.length > 1 && rand() < 0.4) {
        const cut = 1 + Math.floor(rand() * (buf.length - 1));
        chunks.push(buf.subarray(0, cut));
        buf = buf.subarray(cut);
      }
      chunks.push(buf);
    }
  }
  return chunks;
}

/** writes the chunks to a response-like object, ending via end(chunk) or write+bare end() */
export function writeChunks(
  res: { write: (chunk: any) => any, end: (chunk?: any) => any },
  chunks: Array<string | Buffer>,
  rand: () => number,
) {
  const last = chunks[chunks.length - 1];
  for (const chunk of chunks.slice(0, -1)) res.write(chunk);
  if (rand() < 0.5) {
    res.end(last);
  } else {
    res.write(last);
    res.end();
  }
}
