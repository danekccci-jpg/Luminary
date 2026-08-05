/**
 * vkVideoService.ts — VK Video HLS Stream Extractor (Lampa-style).
 *
 * Ищет фильм в публичных видеозаписях VK по названию + году, получает страницу
 * плеера `https://vk.com/video_ext.php?oid=..&id=..&hash=..` и вытаскивает из
 * JSON-контекста плеера (`playerParams`) прямые ссылки на потоки:
 *   - `params.hls` / `params.manifest_url`  → HLS-манифест (.m3u8) для Hls.js
 *   - `params.url2160 / url1080 / url720 …` → прогрессивные MP4 (fallback)
 *
 * Работает в renderer'е: Electron-окно запущено с `webSecurity: false`,
 * поэтому кросс-доменные запросы к vk.com / m.vk.com не блокируются CORS.
 * При недоступности (капча, лимиты, отсутствие результатов) молча возвращает [],
 * не мешая основному потоку с торрентами.
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

interface Candidate {
  ownerId: string;
  videoId: string;
  hash?: string;
  title?: string;
}

/** Отбрасывать ролики короче 10 минут — трейлеры/клипы не нужны. */
const MIN_DURATION_S = 600;
/** Сколько видео резолвить (страницами плеера) и сколько вернуть. */
const RESOLVE_LIMIT = 8;
const RESULT_LIMIT = 6;
/** Кэш запросов, чтобы повторное открытие фильма не дёргало VK. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const searchCache = new Map<string, { at: number; items: VkVideoItem[] }>();

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    signal: controller.signal,
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.5',
      'Referer': 'https://vk.com/',
    },
  }).finally(() => clearTimeout(timer));
}

/**
 * Извлечь JSON-объект `playerParams` из HTML страницы плеера VK.
 * Балансирует фигурные скобки (внутри могут быть вложенные объекты и строки),
 * поэтому простой regex-матч до `};` здесь не годится.
 */
function extractPlayerParamsJson(html: string): any | null {
  const markerIdx = html.indexOf('playerParams');
  if (markerIdx < 0) return null;
  const start = html.indexOf('{', markerIdx);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

interface Playable {
  url: string;
  width: number;
  isHls: boolean;
}

/** Собрать все воспроизводимые URL из playerParams (hls / manifest_url / urlNNN / videos). */
function collectPlayables(params: any): Playable[] {
  const out: Playable[] = [];
  const push = (url: unknown, width: unknown) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      const w = typeof width === 'number' && Number.isFinite(width) ? width : 0;
      out.push({ url, width: w, isHls: /\.m3u8/i.test(url) });
    }
  };

  // 1) params.hls — массив [{url, width}], объект {url, width} или строка
  const hls = params?.hls;
  if (Array.isArray(hls)) hls.forEach((e) => push(e?.url, e?.width));
  else if (hls && typeof hls === 'object') push(hls.url, hls.width);
  else push(hls, 0);

  // 2) params.manifest_url — legacy HLS-манифест
  push(params?.manifest_url, 0);

  // 3) Прогрессивные MP4: url240 … url2160 (у VK есть и 1440p/2160p)
  const progressive: Record<string, number> = {
    url2160: 3840, url1440: 2560, url1080: 1920, url720: 1280,
    url480: 854, url360: 640, url240: 426,
  };
  for (const [key, w] of Object.entries(progressive)) {
    push(params?.[key], w);
  }

  // 4) params.videos — массив [{url, width}]
  const videos = params?.videos;
  if (Array.isArray(videos)) videos.forEach((e) => push(e?.url, e?.width));

  return out.filter((p) => !!p.url && p.url.length > 8);
}

/** Человекочитаемая пометка качества по ширине/URL. */
function qualityLabel(width: number, url: string): string {
  if (width >= 3840 || /2160/i.test(url)) return '4K';
  if (width >= 1920 || /1080/i.test(url)) return '1080p';
  if (width >= 1280 || /720/i.test(url)) return '720p';
  if (width >= 854 || /480/i.test(url)) return '480p';
  return 'SD';
}

/** Пройтись regex'ами по HTML поисковой выдачи и собрать кандидатов. */
function parseVideoReferences(html: string, map: Map<string, Candidate>) {
  const add = (ownerId: string, videoId: string, hash?: string, title?: string) => {
    const key = `${ownerId}_${videoId}`;
    const cur = map.get(key) || { ownerId, videoId };
    if (hash && !cur.hash) cur.hash = hash;
    if (title && !cur.title) cur.title = title;
    map.set(key, cur);
  };

  // Ссылки вида /video-123_456 или /video123_456 (с опциональным hash=)
  const linkRe = /\/video(-?\d+)_(\d+)(?:[^"'\s<>]*?hash=([a-zA-Z0-9]{8,}))?/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) add(m[1], m[2], m[3]);

  // Мобильная разметка: data-id="owner_video"
  const dataIdRe = /(?:data-id|data-video-id|data-vid)="(-?\d+)_(\d+)"/g;
  while ((m = dataIdRe.exec(html))) add(m[1], m[2]);

  // JSON-разметка (витрина/поиск): "video_id":123,"owner_id":-456
  const jsonRe = /"video_id"\s*:\s*(-?\d+)\s*,\s*"owner_id"\s*:\s*(-?\d+)/g;
  while ((m = jsonRe.exec(html))) add(m[2], m[1]);
}

/** Поиск по публичным видеозаписям VK (сначала мобильная версия, затем desktop). */
async function searchCandidates(query: string): Promise<Candidate[]> {
  const q = encodeURIComponent(query);
  const urls = [
    `https://m.vk.com/video?q=${q}&section=search&al=0`,
    `https://vk.com/video?q=${q}&section=search`,
  ];
  const map = new Map<string, Candidate>();
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, 8000);
      if (!res.ok) continue;
      const html = await res.text();
      parseVideoReferences(html, map);
      if (map.size >= RESOLVE_LIMIT) break; // достаточно результатов
    } catch {
      /* пробуем следующий источник */
    }
  }
  return [...map.values()];
}

/** Загрузить страницу плеера и извлечь готовый VkVideoItem (HLS/MP4). */
async function resolveVideo(cand: Candidate): Promise<VkVideoItem | null> {
  const extUrl =
    `https://vk.com/video_ext.php?oid=${cand.ownerId}&id=${cand.videoId}` +
    (cand.hash ? `&hash=${cand.hash}` : '');
  try {
    const res = await fetchWithTimeout(extUrl, 8000);
    if (!res.ok) return null;
    const html = await res.text();
    const params = extractPlayerParamsJson(html);
    if (!params) return null;

    const playables = collectPlayables(params);
    if (playables.length === 0) return null;

    // Длительность — строгий фильтр трейлеров/клипов
    const duration = typeof params.duration === 'number' && Number.isFinite(params.duration)
      ? Math.round(params.duration)
      : undefined;
    if (duration && duration < MIN_DURATION_S) return null;

    const hlsList = playables.filter((p) => p.isHls).sort((a, b) => b.width - a.width);
    const mp4List = playables.filter((p) => !p.isHls).sort((a, b) => b.width - a.width);
    const best = hlsList[0] || mp4List[0];
    if (!best) return null;

    const title =
      typeof params.title === 'string' && params.title.trim()
        ? params.title.trim()
        : cand.title || `VK Video ${cand.ownerId}_${cand.videoId}`;

    return {
      id: `${cand.ownerId}_${cand.videoId}`,
      title,
      duration,
      quality: qualityLabel(best.width, best.url),
      hlsUrl: hlsList[0]?.url,
      mp4Url: mp4List[0]?.url,
      pageUrl: `https://vk.com/video${cand.ownerId}_${cand.videoId}`,
      ownerId: cand.ownerId,
      videoId: cand.videoId,
    };
  } catch {
    return null;
  }
}

const QUALITY_RANK: Record<string, number> = { '4K': 4, '1080p': 3, '720p': 2, '480p': 1, 'SD': 0 };

/**
 * Главный вход: поиск «название + год» → список VkVideoItem с прямыми потоками.
 * Возвращает отсортированные по качеству/длительности результаты (max 6).
 */
export async function searchVkVideo(query: string): Promise<VkVideoItem[]> {
  const q = query.trim();
  if (!q) return [];

  const cached = searchCache.get(q);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items;

  const candidates = await searchCandidates(q);
  if (candidates.length === 0) {
    searchCache.set(q, { at: Date.now(), items: [] });
    return [];
  }

  const settled = await Promise.allSettled(
    candidates.slice(0, RESOLVE_LIMIT).map((c) => resolveVideo(c))
  );
  const items = settled
    .filter((r): r is PromiseFulfilledResult<VkVideoItem | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((v): v is VkVideoItem => !!v)
    .sort(
      (a, b) =>
        (QUALITY_RANK[b.quality] - QUALITY_RANK[a.quality]) ||
        ((b.duration || 0) - (a.duration || 0))
    )
    .slice(0, RESULT_LIMIT);

  searchCache.set(q, { at: Date.now(), items });
  return items;
}
