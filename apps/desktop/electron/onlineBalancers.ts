/**
 * onlineBalancers.ts — бесплатные онлайн-потоки (CDNvideohub + Collaps + Kodik).
 *
 * Аналог торрентов: по Кинопоиск-ID / TMDB-ID / названию получить список
 * балансеров с озвучкой/качеством и прямым HLS (.m3u8) для Hls.js-плеера.
 *
 * Источники (порядок приоритета):
 *  1) CDNvideohub (primary) — plapi.cdnvideohub.com — без токена.
 *     Принимает Кинопоиск-ID. Для сериалов: isSerial + items[] с vkId.
 *     Для фильмов: один vkId → прямой .m3u8.
 *  2) Collaps Embed (secondary) — api.luxembd.ws/embed/kp/{id} — без токена.
 *     HTML-страница с makePlayer({hls: "url"}). Извлекаем .m3u8 regex.
 *     Поиск по названию: api.bhcesh.me/list — возвращает KP-ID.
 *  3) Kodik (fallback) — kodikapi.com — нужен токен (опционально).
 *
 * Все запросы: жёсткие таймауты (6–8с), никогда не бросаем исключение —
 * пустой список с ошибкой для UI (торренты остаются главным источником).
 */

import { net } from 'electron';

// ── Публичный тип потока (для IPC / renderer) ──
export interface OnlineBalancerStream {
  id: string;
  /** Название балансера: CDNvideohub, Collaps, Kodik… */
  source: string;
  /** Нормализованное качество: 4K / 1080p / 720p / SD. */
  quality: string;
  /** Перевод / озвучка: Дубляж, RHS, LostFilm, Оригинал… */
  translation: string;
  /** Прямой HLS-манифест (.m3u8) — основной вариант для Hls.js. */
  m3u8Url?: string;
  /** iframe-ссылка плеера балансера (fallback: внешний плеер). */
  iframeUrl?: string;
  /** Origin для заголовка Referer при воспроизведении. */
  referer?: string;
  /** Сериал ли это (для пикера серий). */
  isSerial?: boolean;
}

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const TIMEOUT_MS = 8000;

function fetchWithTimeout(url: string, headers: Record<string, string>, ms = TIMEOUT_MS): Promise<Response> {
  return Promise.race([
    net.fetch(url, { headers }),
    new Promise<Response>((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}

function normalizeQuality(raw?: string | null): string {
  const q = String(raw || '').toLowerCase();
  if (/2160|4k|uhd/.test(q)) return '4K';
  if (/1080|fhd|full ?hd|blu-?ray|bdrip|web-?dl|web-?rip|hdrip/.test(q)) return '1080p';
  if (/720/.test(q)) return '720p';
  if (/480|sd|dvdrip/.test(q)) return 'SD';
  return '1080p';
}

function dedupe(streams: OnlineBalancerStream[]): OnlineBalancerStream[] {
  const seen = new Set<string>();
  return streams.filter((s) => {
    const k = `${s.source}||${s.translation}||${s.quality}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function sortStreams(streams: OnlineBalancerStream[]): OnlineBalancerStream[] {
  const order: Record<string, number> = { '4K': 0, '1080p': 1, '720p': 2, SD: 3 };
  return [...streams].sort((a, b) => (order[a.quality] ?? 9) - (order[b.quality] ?? 9));
}

function safeId(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join('-').toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'stream';
}

/** Декодировать JSON-строку из HTML-ответа (\/ → /, \\u0026 → &). */
function unescapeJson(s: string): string {
  return s.replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/\\u002F/g, '/');
}

// ═══════════════════════════════════════════════════════
//  1) CDNvideohub — primary (без токена, по Кинопоиск-ID)
// ═══════════════════════════════════════════════════════

interface CdhItem {
  cvhId?: string;
  vkId?: string;
  voiceStudio?: string;
  voiceType?: string;
}

interface CdhPlaylist {
  titleName?: string;
  isSerial?: boolean;
  items?: CdhItem[];
}

async function fetchCdhVideo(vkId: string): Promise<{ hlsUrl?: string }> {
  try {
    const res = await fetchWithTimeout(
      `https://plapi.cdnvideohub.com/api/v1/player/sv/video/${encodeURIComponent(vkId)}`,
      {
        'User-Agent': UA_DESKTOP,
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://player.cdnvideohub.com/',
      },
      TIMEOUT_MS
    );
    if (!res.ok) return {};
    const text = await res.text();
    const un = unescapeJson(text);
    // hlsUrl в JSON-подобном ответе: "hlsUrl":"https://...m3u8..."
    const m = un.match(/"hlsUrl"\s*:\s*"([^"]+)"/i);
    if (m && m[1]) {
      const url = m[1].replace(/\\u0026/g, '&');
      console.log(`[OnlineBalancers] CDNvideohub HLS: ${url.slice(0, 80)}…`);
      return { hlsUrl: url };
    }
    return {};
  } catch {
    return {};
  }
}

async function searchCdnvideohub(kpId: string): Promise<OnlineBalancerStream[]> {
  const playlistUrl = `https://plapi.cdnvideohub.com/api/v1/player/sv/playlist?pub=12&aggr=kp&id=${encodeURIComponent(kpId)}`;
  const res = await fetchWithTimeout(playlistUrl, {
    'User-Agent': UA_DESKTOP,
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://player.cdnvideohub.com/',
  }, TIMEOUT_MS);
  if (!res.ok) throw new Error(`CDNvideohub HTTP ${res.status}`);

  const text = await res.text();
  let json: CdhPlaylist;
  try { json = JSON.parse(text); } catch { throw new Error('CDNvideohub: invalid JSON'); }

  const items = Array.isArray(json.items) ? json.items : [];
  if (items.length === 0) throw new Error('CDNvideohub: нет озвучек');

  const isSerial = !!json.isSerial;
  const streams: OnlineBalancerStream[] = [];

  // Резолвим vkId → hlsUrl параллельно (макс 8)
  const settled = await Promise.allSettled(
    items.slice(0, 8).map(async (item) => {
      if (!item.vkId) return null;
      const { hlsUrl } = await fetchCdhVideo(item.vkId);
      const voice = item.voiceType || item.voiceStudio || 'Озвучка';
      const studio = item.voiceStudio && item.voiceType ? ` (${item.voiceStudio})` : '';
      return {
        id: safeId('cdnvideohub', voice, kpId, item.vkId),
        source: 'CDNvideohub',
        quality: '1080p',
        translation: `${voice}${studio}`,
        m3u8Url: hlsUrl || undefined,
        isSerial,
        referer: hlsUrl ? 'https://player.cdnvideohub.com/' : undefined,
      } as OnlineBalancerStream;
    })
  );

  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) streams.push(s.value);
  }

  console.log(`[OnlineBalancers] CDNvideohub OK: ${kpId} → ${streams.length} озвучек (serial=${isSerial})`);
  return dedupe(streams);
}

// ═══════════════════════════════════════════════════════
//  2) Collaps Embed — secondary (без токена, embed → .m3u8)
// ═══════════════════════════════════════════════════════

async function searchCollapsEmbed(kpId: string): Promise<OnlineBalancerStream[]> {
  const embedUrl = `https://api.luxembd.ws/embed/kp/${encodeURIComponent(kpId)}`;
  const res = await fetchWithTimeout(embedUrl, {
    'User-Agent': UA_DESKTOP,
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Referer': 'https://api.luxembd.ws/',
  }, TIMEOUT_MS);
  if (!res.ok) throw new Error(`Collaps embed HTTP ${res.status}`);

  const html = await res.text();
  const un = unescapeJson(html);

  // makePlayer({...hls: "url"...}) или прямой hls: "url" в <script>
  const hlsMatch = un.match(/hls\s*:\s*"([^"]+\.m3u8[^"]*)"/i);
  if (!hlsMatch?.[1]) throw new Error('Collaps: .m3u8 не найден в embed');

  const hlsUrl = hlsMatch[1].replace(/\\u0026/g, '&');
  console.log(`[OnlineBalancers] Collaps embed HLS: ${hlsUrl.slice(0, 80)}…`);

  return [{
    id: safeId('collaps', 'Дубляж', kpId),
    source: 'Collaps',
    quality: '1080p',
    translation: 'Дубляж',
    m3u8Url: hlsUrl,
    isSerial: /season|seria|episod/i.test(html),
    referer: 'https://api.luxembd.ws/',
  }];
}

// ═══════════════════════════════════════════════════════
//  Collaps Search — получить KP-ID по названию
// ═══════════════════════════════════════════════════════

interface CollapsSearchResult {
  kinopoisk_id?: string | number;
  name?: string;
  year?: string;
  iframe_url?: string;
}

async function searchCollapsByTitle(title: string, year?: string): Promise<string | null> {
  if (!title) return null;
  const token = 'eedefb541aeba871dcfc756e6b31c02e';
  const url = `https://api.bhcesh.me/list?token=${token}&name=${encodeURIComponent(title)}&limit=5`;
  try {
    const res = await fetchWithTimeout(url, {
      'User-Agent': UA_DESKTOP,
      'Accept': 'application/json',
    }, TIMEOUT_MS);
    if (!res.ok) return null;
    const json: any = await res.json();
    const results: CollapsSearchResult[] = Array.isArray(json?.results) ? json.results : [];
    // Ищем точное совпадение по названию + году
    const exact = results.find((r) => {
      const name = String(r.name || '').toLowerCase();
      const q = title.toLowerCase();
      const y = year ? String(r.year) === year : true;
      return name.includes(q) || q.includes(name);
    }) || results[0];
    if (exact?.kinopoisk_id) {
      console.log(`[OnlineBalancers] Collaps search: "${title}" → KP ${exact.kinopoisk_id}`);
      return String(exact.kinopoisk_id);
    }
  } catch (err: any) {
    console.warn('[OnlineBalancers] Collaps search failed:', err?.message || err);
  }
  return null;
}

// ═══════════════════════════════════════════════════════
//  3) Kodik — fallback (нужен токен, по TMDB-ID)
// ═══════════════════════════════════════════════════════

interface KodikResult {
  id?: string | number;
  title?: string;
  quality?: string;
  translation?: { title?: string; type?: string } | null;
  link?: string;
  kinopoisk_id?: string | number;
}

async function searchKodik(opts: {
  token: string;
  kinopoiskId?: string;
  tmdbId?: string;
  title?: string;
  year?: string;
}): Promise<OnlineBalancerStream[]> {
  if (!opts.token) return [];
  const base = 'https://kodikapi.com';
  const common = `token=${encodeURIComponent(opts.token)}&limit=100&with_episodes=false&with_seasons=false`;
  const url = opts.kinopoiskId
    ? `${base}/list?${common}&kinopoisk_id=${encodeURIComponent(opts.kinopoiskId)}`
    : opts.tmdbId
    ? `${base}/list?${common}&tmdb_id=${encodeURIComponent(opts.tmdbId)}`
    : `${base}/search?${common}&title=${encodeURIComponent(String(opts.title || '').trim())}${opts.year ? `&year=${encodeURIComponent(opts.year)}` : ''}`;

  const res = await fetchWithTimeout(url, { 'User-Agent': UA_DESKTOP, 'Accept': 'application/json' }, TIMEOUT_MS);
  if (!res.ok) throw new Error(`Kodik HTTP ${res.status}`);
  const json: any = await res.json();
  const results: KodikResult[] = Array.isArray(json?.results) ? json.results : [];

  const streams: OnlineBalancerStream[] = [];
  for (const r of results) {
    const link = String(r.link || '').trim();
    const translation = String(r.translation?.title || 'Не указано').trim() || 'Не указано';
    streams.push({
      id: safeId('kodik', translation, normalizeQuality(r.quality), String(r.id ?? '')),
      source: 'Kodik',
      quality: normalizeQuality(r.quality),
      translation,
      iframeUrl: link || undefined,
      referer: link ? new URL(link).origin : undefined,
    });
  }
  console.log(`[OnlineBalancers] Kodik OK: ${results.length} результатов`);
  return dedupe(streams);
}

// ═══════════════════════════════════════════════════════
//  Кэш (TTL 10 мин)
// ═══════════════════════════════════════════════════════
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; streams: OnlineBalancerStream[] }>();

function cacheGet(key: string): OnlineBalancerStream[] | undefined {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.at < CACHE_TTL_MS) return entry.streams;
  cache.delete(key);
  return undefined;
}

// ═══════════════════════════════════════════════════════
//  Публичный API
// ═══════════════════════════════════════════════════════
export class OnlineBalancers {
  async searchOnlineStreams(args: {
    kinopoiskId?: number | string;
    tmdbId?: number | string;
    title?: string;
    year?: string;
    kodikToken?: string;
  }): Promise<{ success: boolean; streams: OnlineBalancerStream[]; error?: string }> {
    const kpId = args.kinopoiskId != null ? String(args.kinopoiskId).trim() : '';
    const tmdbId = args.tmdbId != null ? String(args.tmdbId).trim() : '';
    const title = String(args.title || '').trim();
    const year = String(args.year || '').trim();
    const cacheKey = `${kpId}|${tmdbId}|${title}|${year}`;

    const cached = cacheGet(cacheKey);
    if (cached) return { success: true, streams: cached };

    let streams: OnlineBalancerStream[] = [];
    let error: string | undefined;

    // ── Resolve KP-ID: если не передан, ищем через Collaps search ──
    let resolvedKpId = kpId;
    if (!resolvedKpId && title) {
      try {
        const found = await searchCollapsByTitle(title, year || undefined);
        if (found) resolvedKpId = found;
      } catch { /* не критично — Collaps embed тоже может сработать */ }
    }

    // ── 1) CDNvideohub (primary, по KP-ID) ──
    if (resolvedKpId) {
      try {
        streams = await searchCdnvideohub(resolvedKpId);
      } catch (err: any) {
        error = `CDNvideohub: ${err?.message || String(err)}`;
        console.warn('[OnlineBalancers] CDNvideohub:', error);
      }
    }

    // ── 2) Collaps Embed (secondary, по KP-ID → прямой .m3u8) ──
    if (resolvedKpId && streams.length === 0) {
      try {
        streams = await searchCollapsEmbed(resolvedKpId);
      } catch (err: any) {
        console.warn('[OnlineBalancers] Collaps embed:', err?.message || err);
        if (!error) error = `Collaps: ${err?.message || String(err)}`;
      }
    }

    // ── 3) Kodik (fallback, нужен токен) ──
    if (args.kodikToken) {
      try {
        const kodik = await searchKodik({
          token: args.kodikToken,
          kinopoiskId: resolvedKpId || undefined,
          tmdbId: tmdbId || undefined,
          title: title || undefined,
          year: year || undefined,
        });
        streams = dedupe([...streams, ...kodik]);
      } catch (err: any) {
        console.warn('[OnlineBalancers] Kodik:', err?.message || err);
        if (!error) error = `Kodik: ${err?.message || String(err)}`;
      }
    }

    streams = sortStreams(dedupe(streams));
    cache.set(cacheKey, { at: Date.now(), streams });
    return { success: true, streams, error };
  }
}
