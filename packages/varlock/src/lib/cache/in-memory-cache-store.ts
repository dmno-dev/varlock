type InMemoryCacheEntry = {
  value: any;
  cachedAt: number;
  expiresAt: number;
};

export class InMemoryCacheStore {
  private entries = new Map<string, InMemoryCacheEntry>();

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

  async set(cacheKey: string, value: any, ttlMs: number): Promise<void> {
    const now = Date.now();
    this.entries.set(cacheKey, {
      value,
      cachedAt: now,
      expiresAt: Number.isFinite(ttlMs) ? now + ttlMs : now + 100 * 365.25 * 86_400_000,
    });
  }

  delete(cacheKey: string): void {
    this.entries.delete(cacheKey);
  }

  clearAll(): number {
    const count = this.entries.size;
    this.entries.clear();
    return count;
  }

  clearByPrefix(prefix: string): number {
    let count = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        count++;
      }
    }
    return count;
  }

  getStats(): { total: number; expired: number; byPrefix: Record<string, number> } {
    const now = Date.now();
    let expired = 0;
    const byPrefix: Record<string, number> = {};
    for (const [key, entry] of this.entries.entries()) {
      if (now > entry.expiresAt) {
        expired++;
        continue;
      }
      const firstColon = key.indexOf(':');
      const secondColon = firstColon >= 0 ? key.indexOf(':', firstColon + 1) : -1;
      const prefix = secondColon >= 0 ? key.slice(0, secondColon) : key.slice(0, firstColon);
      byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;
    }
    return { total: this.entries.size, expired, byPrefix };
  }

  listEntries(): Array<{ key: string; cachedAt: number; expiresAt: number }> {
    const now = Date.now();
    const out: Array<{ key: string; cachedAt: number; expiresAt: number }> = [];
    for (const [key, entry] of this.entries.entries()) {
      if (now <= entry.expiresAt) {
        out.push({ key, cachedAt: entry.cachedAt, expiresAt: entry.expiresAt });
      }
    }
    return out;
  }

  getFilePath(): string {
    return '[memory]';
  }
}
