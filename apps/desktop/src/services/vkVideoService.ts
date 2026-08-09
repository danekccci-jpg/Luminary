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
 */

export interface VkVideoItem {
  id: string;
  title: string;
  /** Длительность в секундах (если отдал плеер VK). */
  duration?: number;
  /** Пометка качества: 4K / 1080p / 720p / 480p / SD. */
  quality: string;
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
/** Сколько потоков отдаём в UI. */
const RESULT_LIMIT = 6;
/** Кэш запросов — повторное открытие фильма не дёргает агрегатор/VK. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const searchCache = new Map<string, { at: number; items: VkVideoItem[] }>();

/** Качество из названия раздачи (если агрегатор его дал). */
function qualityOf(title?: string): string {
  const t = (title || '').toLowerCase();
  if (/2160p|4k|uhd/.test(t)) return '4K';
  if (/1080p|fhd|full ?hd/.test(t)) return '1080p';
  if (/720p/.test(t)) return '720p';
  if (/480p|sd/.test(t)) return '480p';
  return 'SD';
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

  // Длительность известна и меньше 10 минут — трейлер/клип, не показываем.
  // Неизвестная длительность — показываем (агрегатор мог её не отдать).
  const filtered = items.filter((it) => !it.duration || it.duration >= MIN_DURATION_S);
  const result = filtered.slice(0, RESULT_LIMIT);
  searchCache.set(q, { at: Date.now(), items: result });
  return result;
}
