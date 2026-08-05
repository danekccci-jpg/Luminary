/**
 * jacred.ts — отказоустойчивый клиент JacRed API (архитектура как в Lampa/Vokino).
 *
 * Пул публичных JacRed-инстансов (основной + резервные mirror URL) с авто-
 * переключением: при ошибке/таймауте одного инстанса запрос уходит на следующий.
 * Мёртвые инстансы запоминаются на 60 секунд (cooldown) — повторные поиски в
 * рамках сессии не ждут недоступные хосты.
 *
 * API: GET {base}/api/v1/search?query=..&year=..&trackers=RuTracker.org,NNM-Club,Rutor
 * Ответ: { success: true, data: [{ title, size, seeders, leechers, magnet, tracker, ... }] }
 *
 * ВАЖНО: публичные инстансы волатильны (живут месяцами и умирают). Пул ниже —
 * последний известный набор публичных зеркал; если все мертвы, укажите свой
 * инстанс через localStorage «luminary_jacred_instances» (JSON-массив base-URL),
 * например собственный self-hosted JacRed.
 */

import { TorrentRelease, DubbingType } from '../../types';

/** Таймаут одного инстанса (мс). */
const INSTANCE_TIMEOUT_MS = 6000;
/** Общий лимит на весь цикл фолбэков (мс) — чтобы UI не висел при мёртвом пуле. */
const OVERALL_DEADLINE_MS = 20000;
/** Сколько секунд не трогать инстанс после ошибки. */
const FAIL_COOLDOWN_MS = 60 * 1000;

/** Основной + резервные mirror URL публичных JacRed-инстансов. */
export const JACRED_INSTANCES: string[] = [
  'https://vk.okino.top/jacred', // Vokino mirror — последний из живых
  'https://jacred.app',
  'https://j1.jacred.app',
  'https://j2.jacred.app',
  'https://jacred.net',
];

/** Трекеры, по которым фильтруем выдачу (имена модулей JacRed). */
export const JACRED_TRACKERS = ['RuTracker.org', 'NNM-Club', 'Rutor'] as const;

/** Переопределение пула пользователем: JSON-массив base-URL в localStorage. */
const OVERRIDE_KEY = 'luminary_jacred_instances';

function getInstancePool(): string[] {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((s) => String(s).replace(/\/+$/, '')).filter((s) => /^https?:\/\//i.test(s));
      }
    }
  } catch { /* ignore */ }
  return JACRED_INSTANCES;
}

/** Инстансы на карантине (ошибка/таймаут) — пропускаем до истечения cooldown. */
const deadUntil = new Map<string, number>();

function isDead(base: string): boolean {
  const until = deadUntil.get(base);
  return !!until && until > Date.now();
}

function markDead(base: string) {
  deadUntil.set(base, Date.now() + FAIL_COOLDOWN_MS);
}

function markAlive(base: string) {
  deadUntil.delete(base);
}

/** BTIH-хэш из magnet-ссылки (40 hex или 32 base32). */
export function extractBtih(magnet: string | undefined | null): string {
  const m = String(magnet || '').match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return m ? m[1].toLowerCase() : '';
}

// ── Разметка качества / кодеков / озвучки по названию раздачи ──

function detectQuality(title: string): TorrentRelease['quality'] {
  if (/(4k|2160p|uhd)/i.test(title)) return '4K';
  if (/(1080p|fullhd|\bfhd\b)/i.test(title)) return '1080p';
  if (/(720p|hdrip|hdtv)/i.test(title)) return '720p';
  return 'SD';
}

function detectTags(title: string): string[] {
  const tags: string[] = [];
  if (/(4k|2160p|uhd)/i.test(title)) tags.push('4K');
  if (/remux/i.test(title)) tags.push('Remux');
  if (/dolby[\s-]?vision|\bdv\b/i.test(title)) tags.push('Dolby Vision');
  if (/\bhdr10\b|\bhdr\b/i.test(title)) tags.push('HDR10');
  if (/\bweb-?dl\b/i.test(title)) tags.push('WEB-DL');
  if (/\bblu-?ray\b|\bbd-?rip\b/i.test(title)) tags.push('BDRip');
  return tags.slice(0, 4);
}

function detectVideoCodec(title: string): TorrentRelease['videoCodec'] {
  if (/(hevc|x265|h\.?265)/i.test(title)) return 'HEVC';
  if (/\bav1\b/i.test(title)) return 'AV1';
  if (/(x264|h\.?264|avc)/i.test(title)) return 'H.264';
  return 'Unknown';
}

function detectAudioCodec(title: string): TorrentRelease['audioCodec'] {
  if (/\btruehd\b|atmos/i.test(title)) return 'TrueHD';
  if (/\bdts\b/i.test(title)) return 'DTS';
  if (/\be-?ac-?3\b/i.test(title)) return 'EAC3';
  if (/\bac-?3\b/i.test(title)) return 'AC3';
  if (/\baac\b/i.test(title)) return 'AAC';
  return 'Unknown';
}

function detectDubbing(title: string): DubbingType {
  if (/дубляж/i.test(title)) return 'Дубляж';
  if (/\brhs\b/i.test(title)) return 'RHS';
  if (/hdrezka/i.test(title)) return 'HDRezka';
  if (/lostfilm|лostfilm/i.test(title)) return 'LostFilm';
  if (/tvshows|твшоу/i.test(title)) return 'TVShows';
  if (/кубик в кубе/i.test(title)) return 'Кубик в Кубе';
  return 'Прочее';
}

/** Короткое имя трекера: RuTracker.org → RuTracker, NNM-Club → NNM. */
function normalizeTracker(tracker: string): string {
  const t = String(tracker || '').trim();
  if (/rutracker/i.test(t)) return 'RuTracker';
  if (/nnm/i.test(t)) return 'NNM';
  if (/^rutor$/i.test(t)) return 'Rutor';
  return t || 'JacRed';
}

/** Форматирование размера (байты → «12.3 GB»). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Стабильность раздачи (зеркало формулы electron-скрапера): сиды × битрейт. */
function computeStability(sizeBytes: number, seeders: number) {
  const durationSeconds = 110 * 60; // ~110 мин — дефолтная длительность
  const requiredMbps =
    Math.round(((sizeBytes * 8) / durationSeconds / (1024 * 1024)) * 10) / 10;
  const seedFactor = Math.min(100, Math.max(0, seeders * 4));
  const bitrateFactor = Math.min(100, Math.max(10, 100 - requiredMbps * 1.5));
  const stabilityScore = Math.min(100, Math.max(0, Math.round(seedFactor * 0.6 + bitrateFactor * 0.4)));
  let stabilityLabel: TorrentRelease['stabilityLabel'] = 'Умеренная';
  if (stabilityScore >= 80) stabilityLabel = 'Отличная';
  else if (stabilityScore >= 55) stabilityLabel = 'Хорошая';
  else if (requiredMbps > 65) stabilityLabel = 'Низкий битрэйт';
  return { stabilityScore, stabilityLabel, requiredMbps };
}

/** Привести сырой элемент ответа JacRed к TorrentRelease. */
function normalizeItem(item: any, index: number, query: string): TorrentRelease | null {
  if (!item || typeof item !== 'object') return null;
  const magnet = String(item.magnet || item.MagnetUri || item.link || item.url || '');
  if (!/^magnet:/i.test(magnet)) return null;
  const btih = extractBtih(magnet);
  if (!btih) return null;

  const title = String(item.title || item.Title || item.name || query).trim();
  const sizeBytes =
    typeof item.size === 'number' && Number.isFinite(item.size)
      ? item.size
      : typeof item.Size === 'number' && Number.isFinite(item.Size)
        ? item.Size
        : 4 * 1024 * 1024 * 1024;
  const seeders = Number(item.seeders ?? item.Seeders ?? item.seeds ?? 0) || 0;
  const leechers = Number(item.leechers ?? item.Peers ?? item.peers ?? 0) || 0;
  const tracker = normalizeTracker(item.tracker || item.Tracker || 'JacRed');
  const { stabilityScore, stabilityLabel, requiredMbps } = computeStability(sizeBytes, seeders);

  return {
    id: btih,
    title,
    quality: detectQuality(title),
    tags: detectTags(title),
    dubbing: detectDubbing(title),
    size: formatBytes(sizeBytes),
    sizeBytes,
    seeders,
    leechers,
    magnet,
    source: `JacRed · ${tracker}`,
    videoCodec: detectVideoCodec(title),
    audioCodec: detectAudioCodec(title),
    stabilityScore,
    stabilityLabel,
    requiredMbps,
  };
}

/** Распарсить тело ответа JacRed: { success, data: [...] } или голый массив. */
function parseItems(payload: any, query: string): TorrentRelease[] {
  if (!payload || typeof payload !== 'object') return [];
  const raw: any[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.Results)
        ? payload.Results
        : Array.isArray(payload.torrents)
          ? payload.torrents
          : [];
  const seen = new Set<string>();
  const items: TorrentRelease[] = [];
  raw.forEach((item, i) => {
    const rel = normalizeItem(item, i, query);
    if (!rel) return;
    const btih = extractBtih(rel.magnet);
    if (btih && seen.has(btih)) return;
    if (btih) seen.add(btih);
    items.push(rel);
  });
  return items;
}

function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    signal: controller.signal,
    headers: {
      'Accept': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    },
  }).finally(() => clearTimeout(timer));
}

/**
 * Поиск раздач через JacRed с авто-фолбэком по пулу инстансов.
 * Возвращает раздачи первого отвечающего инстанса (приоритет свежести пула).
 */
export async function searchJacRed(
  query: string,
  year?: string,
  trackers: readonly string[] = JACRED_TRACKERS
): Promise<TorrentRelease[]> {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return [];

  const pool = getInstancePool();
  const params = new URLSearchParams({ query: q });
  if (year) params.set('year', String(year).slice(0, 4));
  if (trackers.length > 0) params.set('trackers', trackers.join(','));

  const deadline = Date.now() + OVERALL_DEADLINE_MS;
  let lastError: unknown = null;
  let lastBase = '';

  for (const base of pool) {
    if (Date.now() > deadline) break;
    if (isDead(base)) continue;

    const url = `${base}/api/v1/search?${params.toString()}`;
    try {
      const res = await fetchWithTimeout(url, INSTANCE_TIMEOUT_MS);
      if (!res.ok) {
        markDead(base);
        lastError = new Error(`HTTP ${res.status}`);
        lastBase = base;
        continue;
      }
      let payload: any;
      try {
        payload = await res.json();
      } catch {
        markDead(base);
        lastError = new Error('Invalid JSON');
        lastBase = base;
        continue;
      }
      // success:false — инстанс отвечает, но поиск/трекеры недоступны → fallback
      if (payload && payload.success === false) {
        markDead(base);
        lastError = new Error(String(payload.error || 'JacRed search failed'));
        lastBase = base;
        continue;
      }
      const items = parseItems(payload, q);
      if (items.length === 0) {
        // Живой инстанс без результатов — пробуем следующий (конфиг трекеров разный)
        markAlive(base);
        continue;
      }
      markAlive(base);
      return items;
    } catch (err: any) {
      markDead(base);
      lastError = err;
      lastBase = base;
      console.warn(`[JacRed] instance failed: ${base} — ${err?.message || err}`);
    }
  }

  if (lastError && lastBase) {
    console.warn(`[JacRed] all instances failed (last: ${lastBase})`);
  }
  return [];
}

// ── Мёрдж и приоритизация ──

const QUALITY_TIER: Record<TorrentRelease['quality'], number> = { '4K': 0, '1080p': 1, '720p': 2, 'SD': 3 };

/**
 * Объединить списки раздач (JacRed + локальный скрапер):
 * 1. Дедупликация по BTIH-хэшу magnet (остаётся раздача с большим числом сидов);
 * 2. Сортировка: 4K/2160p по сидам → 1080p по сидам → остальные.
 */
export function mergeReleasesByHash(...lists: TorrentRelease[][]): TorrentRelease[] {
  const byHash = new Map<string, TorrentRelease>();
  const push = (rel: TorrentRelease) => {
    if (!rel || !rel.magnet) return;
    const btih = extractBtih(rel.magnet);
    const key = btih || `${rel.title}|${rel.sizeBytes}`;
    const prev = byHash.get(key);
    if (!prev || rel.seeders > prev.seeders) byHash.set(key, rel);
  };
  lists.forEach((list) => (Array.isArray(list) ? list : []).forEach(push));

  return Array.from(byHash.values()).sort((a, b) => {
    const tier = QUALITY_TIER[a.quality] - QUALITY_TIER[b.quality];
    if (tier !== 0) return tier;
    if (b.seeders !== a.seeders) return b.seeders - a.seeders;
    // При равных сидах — RU-раздачи выше (кириллица в названии)
    const ruBonus = (/[а-яё]/i.test(b.title) ? 1 : 0) - (/[а-яё]/i.test(a.title) ? 1 : 0);
    if (ruBonus !== 0) return ruBonus;
    return b.stabilityScore - a.stabilityScore;
  });
}
