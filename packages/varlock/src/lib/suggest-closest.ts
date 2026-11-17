/**
 * Levenshtein distance, kept dependency-free for "did you mean" suggestions.
 */
export function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: Array<Array<number>> = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dist[i][0] = i;
  for (let j = 0; j < cols; j++) dist[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i][j] = Math.min(
        dist[i - 1][j] + 1,
        dist[i][j - 1] + 1,
        dist[i - 1][j - 1] + cost,
      );
    }
  }
  return dist[a.length][b.length];
}

/** Names this long are not typos of anything; skipping them also bounds the matrix below. */
const MAX_SUGGEST_LENGTH = 64;

/**
 * Closest candidate within edit distance 2 (by default), or undefined when nothing is close
 * enough. `normalize` is applied to both sides before comparing.
 */
export function suggestClosest(
  typed: string,
  candidates: Array<string>,
  maxDistance = 2,
  normalize: (value: string) => string = (value) => value,
) {
  const typedNormalized = normalize(typed);
  if (typedNormalized.length > MAX_SUGGEST_LENGTH) return undefined;
  let best: { name: string, distance: number } | undefined;
  for (const candidate of candidates) {
    const candidateNormalized = normalize(candidate);
    if (candidateNormalized.length > MAX_SUGGEST_LENGTH) continue;
    // the length gap alone is a lower bound on the distance
    if (Math.abs(typedNormalized.length - candidateNormalized.length) > maxDistance) continue;
    const distance = levenshtein(typedNormalized, candidateNormalized);
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  return best?.name;
}
