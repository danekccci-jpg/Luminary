/**
 * onlineBalancers.ts — renderer-сервис бесплатных онлайн-потоков (KinoBox + Kodik).
 *
 * Поиск выполняется в main-процессе (electron/onlineBalancers.ts): KinoBox API
 * по Кинопоиск-ID + опционально Kodik API (токен из настроек). Renderer только
 * отображает готовые потоки с прямыми .m3u8-манифестами и передаёт их в Hls.js.
 * Все запросы в main с жёсткими таймаутами — при недоступности источника
 * возвращается пустой список, торренты остаются главным источником.
 */

import { OnlineBalancerStream } from '../types';

/** Кэш запросов — повторное открытие фильма не дёргает API. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const searchCache = new Map<string, { at: number; streams: OnlineBalancerStream[] }>();

/** Опциональный Kodik-токен из настроек (localStorage) — без него источник пропускается. */
function getKodikToken(): string {
  try {
    const raw = localStorage.getItem('luminary_settings');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof parsed.kodikToken === 'string') {
        return parsed.kodikToken.trim();
      }
    }
  } catch { /* ignore */ }
  return '';
}

export interface SearchOnlineStreamsArgs {
  /** Кинопоиск-ID (KinoBox API). */
  kinopoiskId?: number | string;
  /** TMDB-ID (Kodik API принимает tmdb_id; у каталога это movie.id). */
  tmdbId?: number | string;
  title?: string;
  year?: string;
}

export async function searchOnlineStreams(args: SearchOnlineStreamsArgs): Promise<OnlineBalancerStream[]> {
  const kinopoiskId = args.kinopoiskId != null ? String(args.kinopoiskId).trim() : '';
  const tmdbId = args.tmdbId != null ? String(args.tmdbId).trim() : '';
  const title = String(args.title || '').trim();
  const year = String(args.year || '').trim();
  const cacheKey = `${kinopoiskId}|${tmdbId}|${title}|${year}`;

  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.streams;

  let streams: OnlineBalancerStream[] = [];
  if (window.electronAPI?.searchOnlineStreams) {
    try {
      const res = await window.electronAPI.searchOnlineStreams(
        kinopoiskId || undefined,
        tmdbId || undefined,
        title || undefined,
        year || undefined,
        getKodikToken() || undefined
      );
      if (res.success && Array.isArray(res.streams)) {
        streams = res.streams.filter((s: any) => s && typeof s === 'object');
      }
    } catch (err: any) {
      console.warn('[OnlineBalancers] Search failed:', err?.message || err);
    }
  }

  searchCache.set(cacheKey, { at: Date.now(), streams });
  return streams;
}
