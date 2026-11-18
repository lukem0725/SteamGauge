import "server-only";

/**
 * lib/steam/memory-cache.ts
 *
 * A small in-process LRU in front of the api_cache table (doc 5.1, "L1.5").
 *
 * Serverless instances share no memory, so this is not a replacement for the
 * Postgres cache: it only saves a warm instance the database round trip
 * (typically 20-60 ms) for keys it has read or written recently. Every
 * instance still treats Postgres as the source of truth:
 *
 *   - cachedFetch serves a memory entry only while it is FRESH. A stale entry
 *     goes to Postgres, where the lease decides who refreshes it, so an
 *     instance never keeps serving old data that another instance has
 *     already refreshed.
 *   - peekCached (cache-only bulk reads) may use fresh or stale entries,
 *     exactly as it does from Postgres.
 *   - Lease placeholders (status "ok" with a null payload) are never stored.
 *
 * Entries are stored as JSON text and parsed on every hit, so no two requests
 * ever share (and could mutate) the same object. The size limit counts that
 * text, so a few large Deals pages cannot push the function out of memory.
 *
 * Player-scoped keys are safe here because cachedFetch checks the session
 * BEFORE it looks at any cache layer. A future "delete my data" must call
 * forgetMemoryCache(...) for the user's keys as well as delete the rows.
 */

/** The fields of an api_cache row that a read needs. */
export interface MemoryRow {
  readonly payload: unknown;
  readonly status: "ok" | "private" | "not_found";
  readonly fetched_at: string;
  readonly fresh_until: string;
  readonly stale_until: string;
}

interface Entry {
  readonly json: string;
  readonly freshUntil: number;
  readonly staleUntil: number;
}

/** Total size of stored JSON text (UTF-16 code units, about bytes for ASCII). */
export const MEMORY_CACHE_MAX_CHARS = 24 * 1024 * 1024;
/** One Deals page is about 0.3 MB; anything far larger is not worth holding. */
export const MEMORY_CACHE_MAX_ENTRY_CHARS = 2 * 1024 * 1024;

class MemoryLru {
  // A Map keeps insertion order: re-inserting on use makes the first key the
  // least recently used one.
  private readonly entries = new Map<string, Entry>();
  private chars = 0;
  hits = 0;
  misses = 0;

  private readonly maxChars: number;
  private readonly maxEntryChars: number;

  constructor(maxChars: number, maxEntryChars: number) {
    this.maxChars = maxChars;
    this.maxEntryChars = maxEntryChars;
  }

  /**
   * The row for `key` if it is still within its stale lifetime, else null.
   * Pass `freshOnly` to also drop rows whose fresh lifetime has ended.
   */
  get(key: string, freshOnly: boolean, now = Date.now()): MemoryRow | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (now >= entry.staleUntil) {
      this.delete(key);
      this.misses++;
      return null;
    }
    if (freshOnly && now >= entry.freshUntil) {
      this.misses++;
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return JSON.parse(entry.json) as MemoryRow;
  }

  set(key: string, row: MemoryRow, now = Date.now()): void {
    // Never hold a lease placeholder: it carries no data.
    if (row.status === "ok" && (row.payload === null || row.payload === undefined)) {
      this.delete(key);
      return;
    }
    const staleUntil = Date.parse(row.stale_until);
    const freshUntil = Date.parse(row.fresh_until);
    if (!Number.isFinite(staleUntil) || !Number.isFinite(freshUntil) || staleUntil <= now) {
      this.delete(key);
      return;
    }
    let json: string;
    try {
      json = JSON.stringify(row);
    } catch {
      return;
    }
    this.delete(key);
    if (json.length > this.maxEntryChars) return;
    this.entries.set(key, { json, freshUntil, staleUntil });
    this.chars += json.length;
    while (this.chars > this.maxChars) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.chars -= entry.json.length;
  }

  forget(matches: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) if (matches(key)) this.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.chars = 0;
    this.hits = 0;
    this.misses = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get storedChars(): number {
    return this.chars;
  }
}

/** One per server instance. */
export const memoryCache = new MemoryLru(MEMORY_CACHE_MAX_CHARS, MEMORY_CACHE_MAX_ENTRY_CHARS);

/** Drops matching keys, e.g. `(key) => key.startsWith("player:7656…:")`. */
export function forgetMemoryCache(matches: (key: string) => boolean): void {
  memoryCache.forget(matches);
}

/** For tests: a fresh, empty cache. */
export function clearMemoryCache(): void {
  memoryCache.clear();
}

/** For tests of eviction. */
export function createMemoryCacheForTest(maxChars: number, maxEntryChars: number): MemoryLru {
  return new MemoryLru(maxChars, maxEntryChars);
}
