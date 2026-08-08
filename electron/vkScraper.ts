/**
 * vkScraper.ts — VK Video БЕЗ авторизации (как плагины Lampa/Lampac).
 *
 * Проблема: VK закрыл анонимный поиск видео (api.vk.com video.search требует
 * токен, веб-поиск — логин). Решение — два публичных шага:
 *
 *  1) ПОИСК: публичный видео-агрегатор (Яндекс.Видео) по названию →
 *     ссылки vk.com/video-<owner>_<id> (без авторизации, 4с таймаут).
 *  2) HLS: vk.com/video_ext.php?oid=..&id=.. → JSON с "hls"/"hls_fmp4"
 *     (открытые видео отдают плеер без логина; 4с таймаут).
 *
 * Все запросы обёрнуты в жёсткие таймауты — при блокировке IP/ошибках
 * UI не зависает: источник просто пропускается.
 */

import { net } from 'electron';
import { TextDecoder } from 'util';

export interface VkScrapeItem {
  ownerId: string;
  videoId: string;
  title?: string;
  duration?: number;
  hlsUrl?: string;
  mp4Url?: string;
}

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 4000;

/** net.fetch с жёстким таймаутом — блокировка источника не вешает поиск. */
function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  ms: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  return Promise.race([
    net.fetch(url, { headers }),
    new Promise<Response>((_, reject) =>
      setTimeout(() => reject(new Error(`VK timeout ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Декодирование ответа: video_ext.php отдаёт windows-1251 (иначе заголовки
 * фильмов — «кракозябры»). UTF-8-декодирование с заменами → перечитываем
 * как windows-1251 через TextDecoder (ICU).
 */
async function responseText(res: Response): Promise<string> {
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    const utf8 = buf.toString('utf8');
    if (!utf8.includes('\uFFFD')) return utf8;
    try {
      return new TextDecoder('windows-1251').decode(buf);
    } catch {
      return utf8;
    }
  } catch {
    return '';
  }
}

/** Уникальные vk.com/video-XX_YY из HTML агрегатора. */
function extractVkLinks(html: string): Array<{ ownerId: string; videoId: string }> {
  const out = new Map<string, { ownerId: string; videoId: string }>();
  const re = /(?:vk\.com|vkvideo\.ru)\/video(-?\d+)_(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const key = `${m[1]}_${m[2]}`;
    if (!out.has(key)) out.set(key, { ownerId: m[1], videoId: m[2] });
  }
  return [...out.values()];
}

// ═══════════════════════════════════════════════════════
//  Источники поиска (пул): первый живой, отдавший ссылки — достаточен.
//  Можно расширять (другие агрегаторы) без изменения остального кода.
// ═══════════════════════════════════════════════════════

/** Яндекс.Видео — публичный агрегатор, отдаёт VK-ссылки без авторизации. */
async function searchViaYandex(query: string): Promise<Array<{ ownerId: string; videoId: string }>> {
  const url = `https://yandex.ru/video/search?text=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, {
    'User-Agent': UA_DESKTOP,
    'Accept-Language': 'ru-RU,ru;q=0.9',
  });
  if (!res.ok) return [];
  const html = await responseText(res);
  return extractVkLinks(html);
}

// ═══════════════════════════════════════════════════════
//  Прямой HLS-извлекатель из открытой страницы плеера.
// ═══════════════════════════════════════════════════════

interface ResolvedVideo {
  hlsUrl?: string;
  mp4Url?: string;
  title?: string;
  duration?: number;
}

/** vk.com/video_ext.php отдаёт JSON со ссылками "hls"/"hls_fmp4" (без логина). */
async function resolveHls(ownerId: string, videoId: string): Promise<ResolvedVideo> {
  const url = `https://vk.com/video_ext.php?oid=${ownerId}&id=${videoId}`;
  const res = await fetchWithTimeout(url, {
    'User-Agent': UA_DESKTOP,
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'Referer': 'https://vk.com/',
  });
  if (!res.ok) return {};
  const text = await responseText(res);
  if (!text || text.length < 1000) return {};
  const un = (s: string) => s.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
  const hls = (text.match(/"hls"\s*:\s*"([^"]+)"/) || [])[1];
  const fmp4 = (text.match(/"hls_fmp4"\s*:\s*"([^"]+)"/) || [])[1];
  const title = (text.match(/"title"\s*:\s*"([^"]+)"/) || [])[1];
  const dur = (text.match(/"duration"\s*:\s*(\d+)/) || [])[1];
  // Некоторые видео отдают имя аудио-дорожки/субтитров вместо названия — отбрасываем
  const TECH_TITLE_RE = /^(ru_auto|ru auto|forced|subtitle|subs?|audio|track|.*\.vtt|.*\.srt)$/i;
  const cleanTitle = title && !TECH_TITLE_RE.test(title) ? un(title) : undefined;
  return {
    hlsUrl: hls ? un(hls) : undefined,
    mp4Url: fmp4 ? un(fmp4) : undefined,
    title: cleanTitle,
    duration: dur ? parseInt(dur, 10) : undefined,
  };
}

export class VkScraper {
  /**
   * Полный поиск: агрегатор → кандидаты → параллельный HLS-резолв.
   * Резолвы идут параллельно (≤8), каждый ≤4с — итого поиск ≤ ~8с.
   */
  async search(query: string): Promise<VkScrapeItem[]> {
    const q = String(query || '').trim().slice(0, 200);
    if (!q) return [];

    // 1) Кандидаты из пула агрегаторов
    let candidates: Array<{ ownerId: string; videoId: string }> = [];
    const sources: Array<(query: string) => Promise<Array<{ ownerId: string; videoId: string }>>> = [
      searchViaYandex,
    ];
    for (const src of sources) {
      try {
        candidates = await src(q);
        if (candidates.length > 0) break;
      } catch {
        /* источник недоступен — пробуем следующий */
      }
    }
    if (candidates.length === 0) return [];

    // 2) Параллельный резолв HLS/MP4
    const settled = await Promise.allSettled(
      candidates.slice(0, 8).map(async (c) => {
        const r = await resolveHls(c.ownerId, c.videoId);
        if (!r.hlsUrl && !r.mp4Url) return null;
        const item: VkScrapeItem = {
          ownerId: c.ownerId,
          videoId: c.videoId,
          title: r.title,
          duration: r.duration,
          hlsUrl: r.hlsUrl,
          mp4Url: r.mp4Url,
        };
        return item;
      })
    );
    return settled
      .filter((x): x is PromiseFulfilledResult<VkScrapeItem | null> => x.status === 'fulfilled')
      .map((x) => x.value)
      .filter((x): x is VkScrapeItem => x !== null);
  }
}
