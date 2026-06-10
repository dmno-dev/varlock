import { expiryFromTtl } from './cache-store';

type InMemoryCacheEntry = {
  value: any;
  cachedAt: number;
  expiresAt: number;
};

/**
 * Process-local cache store used when persisting to disk is not appropriate
 * (CI, file-based encryption fallback, or `@cache=memory`).
 */
export class InMemoryCacheStore {
  private entries = new Map<string, InMemoryCacheEntry>();
  private inFlight = new Map<
    string,
    Promise<{ value: any; cachedAt: number; expiresAt: number; cacheHit: boolean } | undefined>
  >();

  async get(cacheKey: string): Promise<{ value: any; cachedAt: number; expiresAt: number } | undefined> {
    const entry = this.entries.get(cacheKey);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(cacheKey);
      return undefined;
    }
    return {
      value: entry.value,
      cachedAt: entry.cachedAt,
      expiresAt: entry.expiresAt,
    };
  }

  async set(cacheKey: string, value: any, ttlMs: number): Promise<{ cachedAt: number; expiresAt: number }> {
    const now = Date.now();
    const expiresAt = expiryFromTtl(now, ttlMs);
    this.entries.set(cacheKey, { value, cachedAt: now, expiresAt });
    return { cachedAt: now, expiresAt };
  }

  async getOrSet(
    cacheKey: string,
    ttlMs: number,
    producer: () => Promise<any> | any,
  ): Promise<{ value: any; cachedAt: number; expiresAt: number; cacheHit: boolean } | undefined> {
    const existing = await this.get(cacheKey);
    if (existing) {
      return { ...existing, cacheHit: true };
    }

    const inFlight = this.inFlight.get(cacheKey);
    if (inFlight) return await inFlight;

    const pending = (async () => {
      const latest = await this.get(cacheKey);
      if (latest) return { ...latest, cacheHit: true };

      const value = await producer();
      if (value === undefined) return undefined;

      const stored = await this.set(cacheKey, value, ttlMs);
      return { value, ...stored, cacheHit: false };
    })();

    this.inFlight.set(cacheKey, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(cacheKey) === pending) {
        this.inFlight.delete(cacheKey);
      }
    }
  }

  async delete(cacheKey: string): Promise<void> {
    this.entries.delete(cacheKey);
  }

  async clearAll(): Promise<number> {
    const count = this.entries.size;
    this.entries.clear();
    return count;
  }
}
