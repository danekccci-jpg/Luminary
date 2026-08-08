/**
 * onlineBalancers.ts — бесплатные онлайн-потоки (KinoBox + Kodik) как альтернатива торрентам.
 *
 * Идея (Lampa-style): по Кинопоиск-ID/названию получить список «балансеров»
 * (Collaps, Alloha, Hdvb, Videocdn, Ashdi, Cdnmovies…) с качеством и переводами,
 * затем из iframe-плеера балансера извлечь ПРЯМОЙ HLS-манифест (.m3u8),
 * который отдаётся в существующий Hls.js-плеер (без TorrServer и GStreamer).
 *
 * Источники (пул, первый живой — достаточен):
 *  1) KinoBox public API — https://kinobox.tv/api/players?kinopoisk=<id>
 *     (зеркала kinobox.me и старый эндпоинт /api/players/main — как fallback).
 *     ⚠️ Домен kinobox.tv сейчас может быть недоступен/продан (301 → speedtest) —
 *        модуль тихо деградирует: пустой список, UI показывает торренты.
 *  2) Kodik API (ОПЦИОНАЛЬНО) — https://kodikapi.com, нужен токен
 *     (передаётся из настроек; без токена источник пропускается).
 *
 * Все запросы в жёстких таймаутах (6с) — при блокировке/смерти источника
 * возвращается пустой список, поиск торрентов не затрагивается.
 */

import { net } from 'electron';

// ── Публичный тип потока (для IPC / renderer) ──
export interface OnlineBalancerStream {
  /** Уникальный id потока (source + translation + quality). */
  id: string;
  /** Название балансера: Collaps, Alloha, Hdvb, Videocdn, Kodik… */
  source: string;
  /** Нормализованное качество: 4K / 1080p / 720p / SD. */
  quality: string;
  /** Перевод / озвучка: Дубляж, RHS, LostFilm, Оригинал… */
  translation: string;
  /** Прямой HLS-манифест (.m3u8), если извлёкся из iframe-плеера. */
  m3u8Url?: string;
  /** iframe-ссылка плеера балансера (fallback: внешний плеер / страница). */
  iframeUrl?: string;
  /** Origin, который нужно слать как Referer при воспроизведении. */
  referer?: string;
}

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 6000;
/** Сколько iframe-плееров резолвим в .m3u8 за один поиск (параллельно). */
const MAX_RESOLVE = 8;

/** net.fetch с жёстким таймаутом — мёртвый источник не вешает поиск. */
function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  ms: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  return Promise.race([
    net.fetch(url, { headers }),
    new Promise<Response>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)
    ),
  ]);
}

// ═══════════════════════════════════════════════════════
//  Нормализация качества (raw → 4K / 1080p / 720p / SD)
// ═══════════════════════════════════════════════════════
function normalizeQuality(raw?: string | null): string {
  const q = String(raw || '').toLowerCase();
  if (/2160|4k|uhd/.test(q)) return '4K';
  if (/1080|fhd|full ?hd|blu-?ray|bdrip|web-?dl|web-?rip|hdrip/.test(q)) return '1080p';
  if (/720/.test(q)) return '720p';
  if (/480|sd|dvdrip|dvd|tsrip|hq/.test(q)) return 'SD';
  // Без явного разрешения (BDRip/WEBRip…) — балансеры обычно отдают 1080p
  return '1080p';
}

/** Дедупликация по (source, translation, quality). */
function dedupeStreams(streams: OnlineBalancerStream[]): OnlineBalancerStream[] {
  const seen = new Set<string>();
  const out: OnlineBalancerStream[] = [];
  for (const s of streams) {
    const key = `${s.source}||${s.translation}||${s.quality}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** 1080p/4K — в начало списка, затем по имени балансера. */
function sortStreams(streams: OnlineBalancerStream[]): OnlineBalancerStream[] {
  const order: Record<string, number> = { '4K': 0, '1080p': 1, '720p': 2, SD: 3 };
  return [...streams].sort(
    (a, b) =>
      (order[a.quality] ?? 9) - (order[b.quality] ?? 9) ||
      a.source.localeCompare(b.source)
  );
}

function safeId(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join('-').toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'stream';
}

// ═══════════════════════════════════════════════════════
//  1) KinoBox — public API (пул эндпоинтов + зеркала)
// ═══════════════════════════════════════════════════════

/** Сырой объект плеера из ответа KinoBox (поддерживаем v1 и v2 форматы). */
interface KinoboxRawPlayer {
  source?: string;
  name?: string;
  quality?: string | null;
  translation?: string;
  translations?: Array<{ id?: string | number; name?: string }>;
  iframeUrl?: string;
  updatedAt?: string;
}

const KINOBOX_ENDPOINTS: Array<(kp: string) => string> = [
  (kp) => `https://kinobox.tv/api/players?kinopoisk=${kp}`,
  (kp) => `https://kinobox.tv/api/players/main?kinopoisk=${kp}`,
  (kp) => `https://kinobox.me/api/players?kinopoisk=${kp}`,
];

/** v1 (плоский массив) и v2 (сгруппированный) → единый список потоков. */
function kinoboxToStreams(players: KinoboxRawPlayer[]): OnlineBalancerStream[] {
  const out: OnlineBalancerStream[] = [];
  for (const p of players) {
    // v2: source — технический id («collaps»), name — человекочитаемый («Collaps»)
    const source = String(p.name || p.source || 'Плеер').trim() || 'Плеер';
    const iframe = String(p.iframeUrl || '').trim();
    const quality = normalizeQuality(p.quality);
    // v1: одна запись = один перевод
    if (p.translation != null || !Array.isArray(p.translations)) {
      const translation = String(p.translation || 'Не указано').trim() || 'Не указано';
      out.push({
        id: safeId(source, translation, quality),
        source,
        quality,
        translation,
        iframeUrl: iframe || undefined,
      });
    }
    // v2: translations[] — отдельный поток на каждый перевод
    if (Array.isArray(p.translations) && p.translations.length > 0) {
      for (const t of p.translations) {
        const translation = String(t?.name || 'Не указано').trim() || 'Не указано';
        out.push({
          id: safeId(source, translation, quality),
          source,
          quality,
          translation,
          iframeUrl: iframe || undefined,
        });
      }
    }
  }
  return dedupeStreams(out);
}

/** KinoBox: первый живой эндпоинт из пула, вернувший JSON-массив. */
async function searchKinobox(kinopoiskId: string): Promise<OnlineBalancerStream[]> {
  const headers = {
    'User-Agent': UA_DESKTOP,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'Referer': 'https://kinobox.tv/',
  };
  let lastErr: Error | null = null;
  for (const build of KINOBOX_ENDPOINTS) {
    const url = build(kinopoiskId);
    try {
      const res = await fetchWithTimeout(url, headers);
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} @ ${new URL(url).host}`);
        continue;
      }
      const raw = await res.text();
      if (!raw || raw.length < 4) {
        lastErr = new Error(`empty body @ ${new URL(url).host}`);
        continue;
      }
      let json: any;
      try {
        json = JSON.parse(raw);
      } catch {
        // Некоторые зеркала отдают gzip/HTML на JSON-эндпоинте — пропускаем
        lastErr = new Error(`invalid JSON @ ${new URL(url).host}`);
        continue;
      }
      const players: KinoboxRawPlayer[] = Array.isArray(json)
        ? json.filter((x): x is KinoboxRawPlayer => x && typeof x === 'object')
        : [];
      if (players.length > 0) {
        console.log(`[OnlineBalancers] KinoBox OK: ${url} → ${players.length} плееров`);
        return kinoboxToStreams(players);
      }
      lastErr = new Error(`no players @ ${new URL(url).host}`);
    } catch (err: any) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      console.warn(`[OnlineBalancers] KinoBox endpoint failed: ${url} — ${lastErr.message}`);
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

// ═══════════════════════════════════════════════════════
//  2) Kodik API (опционально, нужен токен)
// ═══════════════════════════════════════════════════════

interface KodikResult {
  id?: string | number;
  title?: string;
  quality?: string;
  translation?: { title?: string; type?: string } | null;
  link?: string;
  kinopoisk_id?: string | number;
}

/** Kodik: /list по id (kinopoisk/tmdb/imdb) или /search по названию + году. */
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
  // Kodik принимает любой из id: kinopoisk_id / tmdb_id / imdb_id / shikimori_id
  const url = opts.kinopoiskId
    ? `${base}/list?${common}&kinopoisk_id=${encodeURIComponent(opts.kinopoiskId)}`
    : opts.tmdbId
    ? `${base}/list?${common}&tmdb_id=${encodeURIComponent(opts.tmdbId)}`
    : `${base}/search?${common}&title=${encodeURIComponent(String(opts.title || '').trim())}${
        opts.year ? `&year=${encodeURIComponent(opts.year)}` : ''
      }`;
  const res = await fetchWithTimeout(url, {
    'User-Agent': UA_DESKTOP,
    'Accept': 'application/json, text/plain, */*',
  });
  if (!res.ok) throw new Error(`Kodik HTTP ${res.status}`);
  const json: any = await res.json();
  const results: KodikResult[] = Array.isArray(json?.results) ? json.results : [];
  const streams: OnlineBalancerStream[] = [];
  for (const r of results) {
    const link = String(r.link || '').trim();
    const translation = String(r.translation?.title || 'Не указано').trim() || 'Не указано';
    const quality = normalizeQuality(r.quality);
    streams.push({
      id: safeId('kodik', translation, quality, String(r.id ?? '')),
      source: 'Kodik',
      quality,
      translation,
      iframeUrl: link || undefined,
      referer: link ? new URL(link).origin : undefined,
    });
  }
  console.log(`[OnlineBalancers] Kodik OK: ${results.length} результатов`);
  return dedupeStreams(streams);
}

// ═══════════════════════════════════════════════════════
//  Извлечение прямого .m3u8 из iframe-плеера балансера
// ═══════════════════════════════════════════════════════

/** Все .m3u8-URL из HTML/JS (с учётом экранирования \/ и \u0026). */
function extractM3u8Urls(text: string): string[] {
  const un = text
    .replace(/\\\//g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\u002F/g, '/');
  const urls = new Set<string>();
  // https://…index.m3u8?query — любые варианты
  const re = /https?:\/\/[^"'\s<>\\]+?\.m3u8[^"'\s<>\\]*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(un))) {
    // отрезаем хвостовые кавычки/скобки, попавшие в совпадение
    const clean = (m[0] as string).replace(/[),;'"\s]+$/, '');
    if (/^https?:\/\//i.test(clean)) urls.add(clean);
  }
  return [...urls];
}

/** Лучший кандидат: мастера/master/index/hls предпочтительнее сегментных. */
function pickBestM3u8(urls: string[]): string | undefined {
  if (urls.length === 0) return undefined;
  const score = (u: string) => {
    let s = 0;
    if (/master\.m3u8|index\.m3u8|playlist\.m3u8/i.test(u)) s += 4;
    if (/\/hls\//i.test(u)) s += 2;
    if (/adaptive|abr/i.test(u)) s += 1;
    return s;
  };
  return [...urls].sort((a, b) => score(b) - score(a))[0];
}

/** Скачать iframe-страницу и достать прямой .m3u8 (+ Referer = origin). */
async function resolveHlsFromIframe(iframeUrl: string): Promise<{ m3u8Url?: string; referer?: string }> {
  let origin = '';
  try {
    origin = new URL(iframeUrl).origin;
  } catch {
    return {};
  }
  try {
    const res = await fetchWithTimeout(
      iframeUrl,
      {
        'User-Agent': UA_DESKTOP,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'Referer': 'https://kinobox.tv/',
      },
      REQUEST_TIMEOUT_MS
    );
    if (!res.ok) return { referer: origin };
    const text = await res.text();
    const m3u8 = pickBestM3u8(extractM3u8Urls(text));
    if (m3u8) console.log(`[OnlineBalancers] m3u8 извлечён: ${m3u8.slice(0, 90)}…`);
    return { m3u8Url: m3u8 || undefined, referer: origin };
  } catch {
    return { referer: origin };
  }
}

// ═══════════════════════════════════════════════════════
//  Кэш (TTL 10 мин) — повторное открытие фильма не дёргает API
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
//  Публичный API модуля
// ═══════════════════════════════════════════════════════
export class OnlineBalancers {
  /**
   * Поиск онлайн-потоков: KinoBox (по Кинопоиск-ID) + Kodik (опционально).
   * Никогда не бросает исключение — при сбоях возвращает пустой список
   * с error-сообщением для UI (торренты остаются главным источником).
   */
  async searchOnlineStreams(args: {
    kinopoiskId?: number | string;
    tmdbId?: number | string;
    title?: string;
    year?: string;
    kodikToken?: string;
  }): Promise<{ success: boolean; streams: OnlineBalancerStream[]; error?: string }> {
    const kinopoiskId = args.kinopoiskId != null ? String(args.kinopoiskId).trim() : '';
    const tmdbId = args.tmdbId != null ? String(args.tmdbId).trim() : '';
    const title = String(args.title || '').trim();
    const year = String(args.year || '').trim();
    const cacheKey = `${kinopoiskId}|${tmdbId}|${title}|${year}`;

    const cached = cacheGet(cacheKey);
    if (cached) return { success: true, streams: cached };

    let streams: OnlineBalancerStream[] = [];
    let error: string | undefined;

    // 1) KinoBox — по Кинопоиск-ID
    if (kinopoiskId) {
      try {
        streams = await searchKinobox(kinopoiskId);
      } catch (err: any) {
        error = `KinoBox: ${err?.message || String(err)}`;
        console.warn('[OnlineBalancers] KinoBox недоступен:', error);
      }
    }

    // 2) Kodik — опционально (аниме/сериалы по id или названию), нужен токен
    if (args.kodikToken) {
      try {
        const kodik = await searchKodik({
          token: args.kodikToken,
          kinopoiskId: kinopoiskId || undefined,
          tmdbId: tmdbId || undefined,
          title: title || undefined,
          year: year || undefined,
        });
        streams = dedupeStreams([...streams, ...kodik]);
      } catch (err: any) {
        console.warn('[OnlineBalancers] Kodik недоступен:', err?.message || err);
        if (!error) error = `Kodik: ${err?.message || String(err)}`;
      }
    }

    // 3) Резолв прямых .m3u8 из iframe-плееров (параллельно, каждый ≤6с)
    if (streams.length > 0) {
      const settled = await Promise.allSettled(
        streams.slice(0, MAX_RESOLVE).map(async (s) => {
          if (!s.iframeUrl || s.m3u8Url) return s;
          const r = await resolveHlsFromIframe(s.iframeUrl);
          return { ...s, m3u8Url: r.m3u8Url || s.m3u8Url, referer: r.referer || s.referer };
        })
      );
      streams = settled
        .filter((x): x is PromiseFulfilledResult<OnlineBalancerStream> => x.status === 'fulfilled')
        .map((x) => x.value);
    }

    streams = sortStreams(dedupeStreams(streams));
    cache.set(cacheKey, { at: Date.now(), streams });
    return { success: true, streams, error };
  }
}
