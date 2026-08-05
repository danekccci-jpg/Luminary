/**
 * Client-side IndexedDB cache for catalog metadata.
 * TTL: 6 hours for catalog pages, 1 hour for search results.
 * Eliminates redundant network requests on app restart.
 */

const DB_NAME = 'luminary_cache';
// v2: сброс старого кеша метаданных (некорректные годы из прежних источников)
const DB_VERSION = 2;
const STORE_NAME = 'catalog_cache';

interface CacheEntry<T = any> {
  key: string;
  data: T;
  timestamp: number;
  ttl: number; // milliseconds
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // v1 → v2: удаляем старый кеш целиком (в нём могли остаться неверные
      // годы из прежних источников/раздач) и пересоздаём пустое хранилище
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      db.createObjectStore(STORE_NAME, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStore(mode: IDBTransactionMode = 'readonly'): Promise<IDBObjectStore> {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, mode);
  return tx.objectStore(STORE_NAME);
}

/** Store data in IndexedDB with a TTL. */
export async function cacheSet<T>(key: string, data: T, ttlMs: number = 6 * 60 * 60 * 1000): Promise<void> {
  try {
    const store = await getStore('readwrite');
    const entry: CacheEntry<T> = {
      key,
      data,
      timestamp: Date.now(),
      ttl: ttlMs,
    };
    return new Promise((resolve, reject) => {
      const req = store.put(entry);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // IndexedDB unavailable (e.g. private browsing) — silently ignore
  }
}

/** Retrieve cached data if still valid. Returns null if expired or missing. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const store = await getStore('readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => {
        const entry = req.result as CacheEntry<T> | undefined;
        if (!entry) return resolve(null);
        if (Date.now() - entry.timestamp > entry.ttl) {
          // Expired — delete and return null
          cacheDelete(key).catch(() => {});
          return resolve(null);
        }
        resolve(entry.data);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** Delete a cache entry. */
export async function cacheDelete(key: string): Promise<void> {
  try {
    const store = await getStore('readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
}

/** Clear all expired entries. Call periodically (e.g., on app start). */
export async function cachePrune(): Promise<void> {
  try {
    const store = await getStore('readwrite');
    const now = Date.now();
    return new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        const entry = cursor.value as CacheEntry;
        if (now - entry.timestamp > entry.ttl) {
          cursor.delete();
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
}

/** Clear all cache entries. */
export async function cacheClear(): Promise<void> {
  try {
    const store = await getStore('readwrite');
    return new Promise((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
}

// ═══════════════════════════════════════════════
//  Convenience wrapper with fallback
// ═══════════════════════════════════════════════

/**
 * Try to get data from cache. If missing/expired, call the fetcher,
 * store the result, and return it.
 */
export async function cachedFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number = 6 * 60 * 60 * 1000
): Promise<T> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) {
    console.log(`[Cache] HIT: ${key}`);
    return cached;
  }
  console.log(`[Cache] MISS: ${key} — fetching...`);
  const fresh = await fetcher();
  // Store in background (don't block on cache write)
  cacheSet(key, fresh, ttlMs).catch(() => {});
  return fresh;
}

// Cache key helpers
export const cacheKeys = {
  catalog: (category: string, page: number) => `cat:${category}:${page}`,
  search: (query: string) => `search:${query.toLowerCase().trim()}`,
  movieDetails: (id: string) => `details:${id}`,
  onlineStreams: (title: string, year?: string) => `streams:${title}:${year || ''}`,
};

/** Полная очистка кеша метаданных (IndexedDB) — вызывается при старте приложения,
 *  чтобы устаревшие/некорректные данные (например, годы раздач) перезапросились. */
export async function clearMetaCache(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* IndexedDB недоступен — не критично */
  }
}
