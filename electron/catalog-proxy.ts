import https from 'https';
import http from 'http';
import { URL } from 'url';

// ── Unified catalog item returned by the proxy ──
export interface CatalogItem {
  id: string;                // site-specific id, e.g. "rezka-1234" or "filmix-5678"
  source: 'hdrezka' | 'filmix';
  title: string;             // Russian title
  original_title: string;    // Original (English) title
  year: string;
  type: 'movie' | 'tv';
  poster_url: string;        // original URL from the source site
  rating: string;
  genres: string[];
  description: string;
  url: string;               // page URL on the source site
  quality?: string;
  season_count?: number;
  episode_count?: number;
}

export interface CatalogPage {
  items: CatalogItem[];
  page: number;
  hasMore: boolean;
  totalPages?: number;
}

// ── Browser-like headers to avoid bot detection ──
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate',
  'Cache-Control': 'no-cache',
};

// ── Mirror lists with auto-failover ──
const REZKA_MIRRORS = [
  'https://rezka.ag',
  'https://hdrezka.ag',
  'https://hdrezka.co',
  'https://hdrezka.cm',
  'https://rezka.tv',
];

const FILMIX_MIRRORS = [
  'https://filmix.biz',
  'https://filmix.ac',
  'https://filmix.lol',
  'https://filmix.my',
];

// Track which mirror is currently working (lazy discovery)
let activeRezkaMirror = 0;
let activeFilmixMirror = 0;

/**
 * Try a list of mirror URLs. Returns the response from the first
 * successful mirror. Auto-updates the active mirror index on success
 * and advances on failure.
 */
async function tryMirrors(
  mirrors: string[],
  activeIdx: { idx: number },
  pathBuilder: (base: string) => string,
  headers: Record<string, string> = {},
  timeout: number = 8000
): Promise<string> {
  // Start from the last known working mirror
  const total = mirrors.length;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < total; attempt++) {
    const idx = (activeIdx.idx + attempt) % total;
    const base = mirrors[idx];
    const url = pathBuilder(base);

    try {
      const html = await httpGet(url, { Referer: base, ...headers }, timeout);
      // Success — remember this mirror for next time
      activeIdx.idx = idx;
      console.log(`[CatalogProxy] Mirror OK: ${base}`);
      return html;
    } catch (err: any) {
      lastErr = err as Error;
      console.warn(`[CatalogProxy] Mirror ${base} failed: ${err.message}`);
      // Try next mirror
    }
  }

  throw lastErr || new Error('All mirrors exhausted');
}

// ── Simple in-memory cache (5 min TTL) ──
const cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function cacheGet(key: string): any | undefined {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  cache.delete(key);
  return undefined;
}

function cacheSet(key: string, data: any) {
  cache.set(key, { data, ts: Date.now() });
}

// ── Generic HTTP GET with redirects ──
function httpGet(url: string, headers: Record<string, string> = {}, timeout: number = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { ...BROWSER_HEADERS, ...headers },
      timeout,
      rejectUnauthorized: false,
    };

    const req = mod.request(opts, (res) => {
      // Follow redirects
      if ([301, 302, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
        httpGet(res.headers.location, headers).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve(body));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ═══════════════════════════════════════════════════════
//  HDRezka Catalog Parser
// ═══════════════════════════════════════════════════════

async function rezkaSearch(query: string): Promise<CatalogItem[]> {
  const cacheKey = `rezka_search_${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const rezkaIdx = { idx: activeRezkaMirror };

  try {
    const html = await tryMirrors(
      REZKA_MIRRORS,
      rezkaIdx,
      (base) => `${base}/engine/ajax/search.php?q=${encodeURIComponent(query)}`,
      { 'X-Requested-With': 'XMLHttpRequest' },
      6000
    );
    activeRezkaMirror = rezkaIdx.idx;
    const items = parseRezkaSearchResults(html, query, REZKA_MIRRORS[activeRezkaMirror]);
    cacheSet(cacheKey, items);
    return items;
  } catch (err: any) {
    console.warn(`[CatalogProxy] HDRezka search failed: ${err.message}`);
    return [];
  }
}

function parseRezkaSearchResults(html: string, query: string, baseUrl: string): CatalogItem[] {
  const items: CatalogItem[] = [];
  // HDRezka search returns <li> items with <a> links
  const liRegex = /<li[^>]*>[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/li>/gi;
  let match;

  while ((match = liRegex.exec(html)) !== null) {
    const href = match[1];
    const inner = match[2];

    // Extract year
    const yearMatch = inner.match(/\[(\d{4}(?:-\d{4})?)\]/);
    const year = yearMatch ? yearMatch[1].substring(0, 4) : '';

    // Extract type
    const isSeries = /сериал/i.test(inner) || href.includes('/series/');

    // Extract title
    let title = inner
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[.*?\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) title = query;

    // Extract English title if present
    let originalTitle = '';
    const enMatch = inner.match(/<i>([^<]+)<\/i>/);
    if (enMatch) originalTitle = enMatch[1].trim();
    if (!originalTitle) originalTitle = title;

    // Extract rating
    const ratingMatch = inner.match(/rating[^>]*>([\d.]+)</);
    const rating = ratingMatch ? ratingMatch[1] : '';

    const id = `rezka-${Buffer.from(href).toString('base64').slice(0, 16)}`;

    items.push({
      id,
      source: 'hdrezka',
      title: title || query,
      original_title: originalTitle || title,
      year,
      type: isSeries ? 'tv' : 'movie',
      poster_url: '',
      rating,
      genres: [],
      description: '',
      url: href.startsWith('http') ? href : `${baseUrl}${href}`,
    });
  }

  return items;
}

async function rezkaCatalog(category: string, page: number = 1): Promise<CatalogPage> {
  const cacheKey = `rezka_cat_${category}_${page}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const paths: Record<string, string> = {
    popular_movies: '/films/?filter=last',
    new_movies: '/films/?filter=watching',
    best_movies: '/films/best/',
    popular_series: '/series/?filter=last',
    new_series: '/series/?filter=watching',
    best_series: '/series/best/',
    animation: '/animation/',
  };

  const path = paths[category] || '/films/';
  const pageParam = page > 1 ? `page=${page}` : '';
  const rezkaIdx = { idx: activeRezkaMirror };

  try {
    const html = await tryMirrors(
      REZKA_MIRRORS,
      rezkaIdx,
      (base) => {
        const sep = path.includes('?') ? '&' : '?';
        const qs = pageParam ? `${sep}${pageParam}` : '';
        return `${base}${path}${qs}`;
      },
      {},
      8000
    );
    activeRezkaMirror = rezkaIdx.idx;
    const items = parseRezkaCatalog(html, REZKA_MIRRORS[activeRezkaMirror]);
    const result: CatalogPage = {
      items,
      page,
      hasMore: items.length >= 15 && page < 10,
      totalPages: page + 1,
    };
    cacheSet(cacheKey, result);
    return result;
  } catch (err: any) {
    console.warn(`[CatalogProxy] HDRezka catalog ${category} failed: ${err.message}`);
    return { items: [], page, hasMore: false };
  }
}

function parseRezkaCatalog(html: string, baseUrl: string): CatalogItem[] {
  const items: CatalogItem[] = [];

  // HDRezka catalog items are in <div class="b-content__inline_item">
  const itemRegex = /<div[^>]+class="[^"]*b-content__inline_item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
  let match;

  while ((match = itemRegex.exec(html)) !== null) {
    const block = match[1];

    // Extract link and title
    const linkMatch = block.match(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const href = linkMatch[1];
    const linkInner = linkMatch[2];

    // Extract poster
    const imgMatch = linkInner.match(/<img[^>]+src="([^"]+)"/i);
    const poster = imgMatch ? imgMatch[1] : '';

    // Extract title from the text block
    const titleMatch = block.match(/class="[^"]*b-content__inline_item-link[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    let title = '';
    let originalTitle = '';

    if (titleMatch) {
      const raw = titleMatch[1].replace(/<[^>]+>/g, ' ').trim();
      title = raw;
    } else {
      // Fallback: get from link inner
      title = linkInner.replace(/<[^>]+>/g, ' ').trim();
    }

    // Year
    const yearMatch = block.match(/(\d{4})/);
    const year = yearMatch ? yearMatch[1] : '';

    // Rating
    const ratingMatch = block.match(/rating[^>]*>([\d.]+)</);
    const rating = ratingMatch ? ratingMatch[1] : '';

    // Type detection
    const isSeries = /сериал/i.test(block) || href.includes('/series/');

    // Genre
    const genreMatch = block.match(/class="[^"]*b-content__inline_item-genre[^"]*"[^>]*>([^<]+)</i);
    const genres = genreMatch ? [genreMatch[1].trim()] : [];

    // Quality
    const qualityMatch = block.match(/class="[^"]*b-content__inline_item-theme[^"]*"[^>]*>([^<]+)</i);
    const quality = qualityMatch ? qualityMatch[1].trim() : '';

    // Description
    const descMatch = block.match(/class="[^"]*b-content__inline_item-text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const description = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    const id = `rezka-${Buffer.from(href).toString('base64').slice(0, 16)}`;
    const fullUrl = href.startsWith('http') ? href : `${baseUrl}${href}`;

    items.push({
      id,
      source: 'hdrezka',
      title: title || 'Без названия',
      original_title: originalTitle || title,
      year,
      type: isSeries ? 'tv' : 'movie',
      poster_url: poster,
      rating,
      genres,
      description,
      quality,
      url: fullUrl,
    });
  }

  return items;
}

// ═══════════════════════════════════════════════════════
//  Filmix Catalog
// ═══════════════════════════════════════════════════════

async function filmixSearch(query: string): Promise<CatalogItem[]> {
  const cacheKey = `filmix_search_${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const filmixIdx = { idx: activeFilmixMirror };

  try {
    // Filmix has a search API endpoint
    const html = await tryMirrors(
      FILMIX_MIRRORS,
      filmixIdx,
      (base) => `${base}/api/v2/search?q=${encodeURIComponent(query)}`,
      { 'X-Requested-With': 'XMLHttpRequest' },
      6000
    );
    activeFilmixMirror = filmixIdx.idx;
    const items = parseFilmixResults(html, query, FILMIX_MIRRORS[activeFilmixMirror]);
    cacheSet(cacheKey, items);
    return items;
  } catch (err: any) {
    console.warn(`[CatalogProxy] Filmix search failed: ${err.message}`);
    // Fallback: try Filmix HTML search
    try {
      const filmixIdx2 = { idx: activeFilmixMirror };
      const html = await tryMirrors(
        FILMIX_MIRRORS,
        filmixIdx2,
        (base) => `${base}/search?q=${encodeURIComponent(query)}`,
        {},
        6000
      );
      activeFilmixMirror = filmixIdx2.idx;
      const items = parseFilmixHtmlSearch(html, query, FILMIX_MIRRORS[activeFilmixMirror]);
      cacheSet(cacheKey, items);
      return items;
    } catch (e2: any) {
      return [];
    }
  }
}

function parseFilmixResults(json: string, query: string, baseUrl: string): CatalogItem[] {
  try {
    const data = JSON.parse(json);
    const results = Array.isArray(data) ? data : data?.results || data?.data || [];
    return results.map((item: any, i: number) => ({
      id: `filmix-${item.id || i}`,
      source: 'filmix' as const,
      title: item.title || item.name || query,
      original_title: item.original_title || item.title || '',
      year: String(item.year || ''),
      type: (item.type === 'series' || item.is_series ? 'tv' : 'movie') as 'movie' | 'tv',
      poster_url: item.poster || item.poster_url || item.image || '',
      rating: String(item.rating || item.imdb_rating || ''),
      genres: Array.isArray(item.genres) ? item.genres : [],
      description: item.description || item.plot || '',
      url: item.url || `${baseUrl}/film/${item.id}`,
      quality: item.quality || '',
      season_count: item.season_count,
      episode_count: item.episode_count,
    }));
  } catch {
    return [];
  }
}

function parseFilmixHtmlSearch(html: string, query: string, baseUrl: string): CatalogItem[] {
  const items: CatalogItem[] = [];
  const cardRegex = /<div[^>]+class="[^"]*movie-item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    const block = match[1];
    const linkMatch = block.match(/<a[^>]+href="([^"]+)"/i);
    const imgMatch = block.match(/<img[^>]+src="([^"]+)"/i);
    const titleMatch = block.match(/class="[^"]*title[^"]*"[^>]*>([^<]+)</i);
    const yearMatch = block.match(/(\d{4})/);

    if (!linkMatch || !titleMatch) continue;

    items.push({
      id: `filmix-${Buffer.from(linkMatch[1]).toString('base64').slice(0, 16)}`,
      source: 'filmix',
      title: titleMatch[1].trim(),
      original_title: '',
      year: yearMatch ? yearMatch[1] : '',
      type: 'movie',
      poster_url: imgMatch ? imgMatch[1] : '',
      rating: '',
      genres: [],
      description: '',
      url: linkMatch[1].startsWith('http') ? linkMatch[1] : `${baseUrl}${linkMatch[1]}`,
    });
  }

  return items;
}

async function filmixCatalog(category: string, page: number = 1): Promise<CatalogPage> {
  const cacheKey = `filmix_cat_${category}_${page}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const endpoints: Record<string, string> = {
    popular_movies: '/api/v2/movies?sort=popular&page=',
    new_movies: '/api/v2/movies?sort=new&page=',
    best_movies: '/api/v2/movies?sort=rating&page=',
    popular_series: '/api/v2/series?sort=popular&page=',
    new_series: '/api/v2/series?sort=new&page=',
    animation: '/api/v2/animation?sort=popular&page=',
  };

  const path = endpoints[category] || endpoints.popular_movies;

  const filmixIdx = { idx: activeFilmixMirror };

  try {
    const json = await tryMirrors(
      FILMIX_MIRRORS,
      filmixIdx,
      (base) => `${base}${path}${page}`,
      {},
      7000
    );
    activeFilmixMirror = filmixIdx.idx;
    const items = parseFilmixResults(json, '', FILMIX_MIRRORS[activeFilmixMirror]);
    const result: CatalogPage = {
      items,
      page,
      hasMore: items.length >= 20 && page < 10,
      totalPages: page + 1,
    };
    cacheSet(cacheKey, result);
    return result;
  } catch (err: any) {
    console.warn(`[CatalogProxy] Filmix catalog ${category} failed: ${err.message}`);
    return { items: [], page, hasMore: false };
  }
}

// ═══════════════════════════════════════════════════════
//  Unified catalog API (tries both sources)
// ═══════════════════════════════════════════════════════

export class CatalogProxy {
  /**
   * Global search across HDRezka + Filmix.
   * Returns merged & deduplicated results.
   */
  async search(query: string): Promise<CatalogItem[]> {
    if (!query.trim()) return [];
    const q = query.trim().slice(0, 200);

    const [rezkaResults, filmixResults] = await Promise.allSettled([
      rezkaSearch(q),
      filmixSearch(q),
    ]);

    const merged: CatalogItem[] = [];
    const seen = new Set<string>();

    const addItems = (items: CatalogItem[]) => {
      for (const item of items) {
        const key = `${item.source}:${item.title}:${item.year}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(item);
        }
      }
    };

    if (rezkaResults.status === 'fulfilled') addItems(rezkaResults.value);
    if (filmixResults.status === 'fulfilled') addItems(filmixResults.value);

    if (merged.length === 0) {
      console.warn(`[CatalogProxy] Zero results for "${q}" — returning empty`);
    }

    return merged.slice(0, 50);
  }

  /**
   * Fetch catalog page from HDRezka (primary) with Filmix fallback.
   */
  async getCatalog(category: string, page: number = 1): Promise<CatalogPage> {
    // Try HDRezka first
    const rezka = await rezkaCatalog(category, page);
    if (rezka.items.length > 0) return rezka;

    // Fallback to Filmix
    console.log(`[CatalogProxy] HDRezka empty for ${category}, trying Filmix...`);
    return await filmixCatalog(category, page);
  }

  /**
   * Download image as base64 data URI (for proxy).
   */
  async proxyImage(imageUrl: string): Promise<{ data: Buffer; contentType: string } | null> {
    if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return null;

    const cacheKey = `img_${imageUrl}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    return new Promise((resolve) => {
      try {
        const parsed = new URL(imageUrl);
        const mod = parsed.protocol === 'https:' ? https : http;

        const req = mod.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
              ...BROWSER_HEADERS,
              'Referer': parsed.origin,
            },
            timeout: 6000,
            rejectUnauthorized: false,
          },
          (res) => {
            if (res.statusCode !== 200) {
              resolve(null);
              return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const data = Buffer.concat(chunks);
              const contentType = res.headers['content-type'] || 'image/jpeg';
              const result = { data, contentType };
              cacheSet(cacheKey, result);
              resolve(result);
            });
          }
        );

        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
      } catch {
        resolve(null);
      }
    });
  }

  /** Generate a data-URI SVG placeholder with the title. */
  getPlaceholderSVG(title: string): string {
    const safe = (title || 'Luminary')
      .replace(/[<>&"']/g, '')
      .slice(0, 42);
    const lines = safe.length > 22 ? [safe.slice(0, 22), safe.slice(22)] : [safe];
    const textSvg = lines
      .map(
        (line, i) =>
          `<text x="50%" y="${48 + i * 7}%" text-anchor="middle" fill="rgba(240,242,248,0.85)" font-family="Segoe UI, Arial, sans-serif" font-size="14" font-weight="700">${line}</text>`
      )
      .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0a0a0d"/>
          <stop offset="50%" stop-color="#12141c"/>
          <stop offset="100%" stop-color="#1a1030"/>
        </linearGradient>
      </defs>
      <rect width="500" height="750" fill="url(#g)"/>
      <rect x="24" y="24" width="452" height="702" rx="28" fill="none" stroke="rgba(0,242,254,0.25)" stroke-width="2"/>
      <circle cx="250" cy="280" r="48" fill="none" stroke="rgba(0,242,254,0.35)" stroke-width="2"/>
      <polygon points="240,255 240,305 280,280" fill="rgba(0,242,254,0.7)"/>
      ${textSvg}
      <text x="50%" y="92%" text-anchor="middle" fill="rgba(0,242,254,0.45)" font-family="Segoe UI, Arial, sans-serif" font-size="11" letter-spacing="3">LUMINARY</text>
    </svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
}

export const catalogProxy = new CatalogProxy();
