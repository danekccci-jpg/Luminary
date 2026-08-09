/**
 * vkVideoService.ts — VK Video HLS Stream Extractor (Lampa-style, БЕЗ токена).
 *
 * Поиск выполняется в main-процессе (electron/vkScraper.ts):
 *  1) публичный видео-агрегатор (Яндекс.Видео) по названию →
 *     ссылки vk.com/video-<owner>_<id> (без авторизации);
 *  2) прямой HLS из vk.com/video_ext.php — открытые видео отдают плеер
 *     без логина (json "hls"/"hls_fmp4").
 * Renderer только отображает готовые потоки. Все запросы в main с жёсткими
 * таймаутами (4с) — при блокировке/ошибках возвращается пустой список,
 * никаких ошибок авторизации в UI.
 *
 * Здесь же:
 *  · «только фильмы» — отсев эфиров/трансляций/стримов/клипов (страховка
 *    поверх фильтра в main-скрапере);
 *  · детект озвучки из заголовка (Дубляж/RHS/LostFilm/HDRezka…) — для чипов
 *    на карточке и выбора озвучки перед просмотром;
 *  · дедуп по фильму (нормализованное название + озвучка) — из шести почти
 *    одинаковых загрузок оставляем лучшие.
 */

import { parseTorrentMeta } from '../utils/torrentMeta';

export interface VkVideoItem {
  id: string;
  title: string;
  /** Длительность в секундах (если отдал плеер VK). */
  duration?: number;
  /** Пометка качества: 4K / 1080p / 720p / 480p / SD. */
  quality: string;
  /** Озвучка из заголовка: Дубляж, RHS, LostFilm… (undefined — не распознана). */
  dubbing?: string;
  /** Прямой HLS-манифест (.m3u8) — основной вариант для Hls.js. */
  hlsUrl?: string;
  /** Прогрессивный MP4 — fallback для нативного воспроизведения. */
  mp4Url?: string;
  /** Страница видео vk.com/video{owner}_{id}. */
  pageUrl?: string;
  ownerId?: string;
  videoId?: string;
}

/** Отбрасывать ролики короче 10 минут — трейлеры/клипы не нужны. */
const MIN_DURATION_S = 600;
/** «Вечные» записи эфира (>6 ч) — тоже не кино. */
const MAX_DURATION_S = 6 * 3600;
/** Сколько потоков отдаём в UI (после фильтрации и дедупа). */
const RESULT_LIMIT = 4;
/** Кэш запросов — повторное открытие фильма не дёргает агрегатор/VK. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const searchCache = new Map<string, { at: number; items: VkVideoItem[] }>();

/** Маркеры эфиров/стримов/трейлеров — страховка поверх фильтра в main. */
const NON_MOVIE_RE =
  /прямой\s*эфир|прямая\s*трансляция|\bтрансляция\b|запись\s*эфира|в\s*эфире|\bэфир\b|\bстрим\b|\bлетсплей\b|gameplay|играет|смотрит|презентация|промо|трейлер|тизер/i;

/** Качество из названия раздачи (если агрегатор его дал). */
function qualityOf(title?: string): string {
  const t = (title || '').toLowerCase();
  if (/2160p|4k|uhd/.test(t)) return '4K';
  if (/1080p|fhd|full ?hd/.test(t)) return '1080p';
  if (/720p/.test(t)) return '720p';
  if (/480p|sd/.test(t)) return '480p';
  return 'SD';
}

/** Озвучка из заголовка (RU_STUDIOS из torrentMeta — порядок = приоритет). */
function dubbingOf(title?: string): string | undefined {
  const meta = parseTorrentMeta(title || '');
  return meta.dubbings[0];
}

/** «Фильм ли это»: не эфир/стрим/клип и длительность в разумных пределах. */
function isNonMovie(it: VkVideoItem): boolean {
  if (it.duration && (it.duration < MIN_DURATION_S || it.duration > MAX_DURATION_S)) return true;
  return NON_MOVIE_RE.test(it.title || '');
}

/** Нормализация названия для группировки одной и той же загрузки фильма.
 *  Срезаем качество, год и слова озвучки — чтобы «Интерстеллар дубляж 1080p»
 *  и «Интерстеллар (2014) оригинал» сгруппировались в одну карточку фильма. */
export function normalizeVkTitle(title?: string): string {
  const DUBBING_WORDS =
    /дубляж|многоголос|двухголос|профессиональн|закадров|оригинал|субтитр|lost\s?film|hdrezka|\brhs\b|ozz|new\s?studio|новостуди|пифагор|сектор/i;
  return (title || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // [1080p], (2021)
    .replace(/\b(19\d{2}|20\d{2})\b/g, ' ') // год
    .replace(/\b(4k|2160p|1080p|720p|480p|360p|fhd|full\s?hd|hd|sd)\b/g, ' ')
    .replace(DUBBING_WORDS, ' ')
    .replace(/смотреть\s*онлайн|в\s*хорошем\s*качестве|бесплатно|полностью|фильм\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const QUALITY_RANK: Record<string, number> = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, SD: 4 };

/** Дедуп: одна карточка на (фильм + озвучка), берём лучший по качеству/HLS. */
function dedupeByFilm(items: VkVideoItem[]): VkVideoItem[] {
  const best = new Map<string, VkVideoItem>();
  for (const it of items) {
    const key = `${normalizeVkTitle(it.title)}|${it.dubbing || ''}`;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, it);
      continue;
    }
    const prevScore = QUALITY_RANK[prev.quality] ?? 9;
    const curScore = QUALITY_RANK[it.quality] ?? 9;
    const prevHls = prev.hlsUrl ? 0 : 1;
    const curHls = it.hlsUrl ? 0 : 1;
    if (curScore < prevScore || (curScore === prevScore && curHls < prevHls)) {
      best.set(key, it);
    }
  }
  return [...best.values()];
}

/** VK CDN блокирует запросы из renderer (Origin) — потоки идут через
 *  main-прокси vkstream:// (см. electron/main.ts registerVkStreamProtocol). */
function proxyUrl(url?: string): string | undefined {
  if (!url) return undefined;
  return `vkstream://proxy?u=${encodeURIComponent(url)}`;
}

export async function searchVkVideo(query: string): Promise<VkVideoItem[]> {
  const q = query.trim();
  if (!q) return [];

  const cached = searchCache.get(q);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items;

  let items: VkVideoItem[] = [];
  if (window.electronAPI?.vkScrapeVideo) {
    try {
      const res = await window.electronAPI.vkScrapeVideo(q);
      if (res.success && Array.isArray(res.items)) {
        items = res.items
          .filter((it: any) => it && (it.hlsUrl || it.mp4Url))
          .map((it: any) => ({
            id: `${it.ownerId}_${it.videoId}`,
            title: it.title || q,
            duration: it.duration,
            quality: qualityOf(it.title),
            dubbing: dubbingOf(it.title),
            hlsUrl: proxyUrl(it.hlsUrl),
            mp4Url: proxyUrl(it.mp4Url),
            pageUrl: `https://vk.com/video${it.ownerId}_${it.videoId}`,
            ownerId: it.ownerId,
            videoId: it.videoId,
          }));
      }
    } catch (err: any) {
      console.warn('[VK] Scrape failed:', err?.message || err);
    }
  }

  // «Только фильмы»: убираем эфиры/стримы/клипы/трейлеры и нереалистичные
  // длительности; затем дедуп (лучший по качеству на фильм+озвучку) и лимит.
  const filtered = items.filter((it) => !isNonMovie(it));
  const result = dedupeByFilm(filtered).slice(0, RESULT_LIMIT);
  searchCache.set(q, { at: Date.now(), items: result });
  return result;
}
