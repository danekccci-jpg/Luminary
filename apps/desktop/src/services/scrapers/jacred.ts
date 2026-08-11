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
/** Общий лимит на поиск по всем зеркалам (мс) — UI не должен виснуть. */
const OVERALL_DEADLINE_MS = 12000;
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

/**
 * Удалённые источники актуального списка зеркал (JacRed Dynamic Router).
 * Загружаются на старте приложения; при 404/таймауте — молча используется
 * дефолтный пул + пользовательские инстансы. Поддерживаемые форматы:
 * JSON-массив строк, JSON-объект { instances: [...] }, plain-text по строкам.
 */
export const REMOTE_POOL_SOURCES: string[] = [
  // Собственный список проекта (файл apps/desktop/jacred-instances.txt в репозитории):
  // https://raw.githubusercontent.com/<owner>/Luminary/master/apps/desktop/jacred-instances.txt
  'https://raw.githubusercontent.com/danekccci-jpg/Luminary/master/apps/desktop/jacred-instances.txt',
  // Запасные общественные списки (появляются/исчезают вместе с зеркалами):
  'https://raw.githubusercontent.com/SuNNjek/JacRed/master/instances.txt',
  'https://raw.githubusercontent.com/SuNNjek/JacRed/master/instances.json',
];

/** Динамически загруженный пул (remote CDN/Gist) — приоритетнее дефолтов. */
let remotePool: string[] = [];
let remotePoolLoadedAt = 0;
const REMOTE_POOL_TTL_MS = 6 * 60 * 60 * 1000; // обновляем список раз в 6 часов

/** Распарсить ответ источника списка (JSON-массив | { instances } | plain text). */
export function parseInstanceList(text: string): string[] {
  if (!text || !text.trim()) return [];
  const norm = (s: string) => String(s).trim().replace(/\/+$/, '');
  const valid = (s: string) => /^https?:\/\//i.test(s);
  // 1) JSON
  try {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : Array.isArray(j?.instances) ? j.instances : [];
    const urls = arr.map((x: any) => (typeof x === 'string' ? norm(x) : x?.url ? norm(x.url) : '')).filter(valid);
    if (urls.length) return urls;
  } catch { /* не JSON — пробуем plain text */ }
  // 2) Plain text: по одной ссылке на строку (комментарии # и пустые строки пропускаем)
  return text
    .split('\n')
    .map((s) => norm(s.split(/[#\s]/)[0]))
    .filter(valid);
}

/** Авто-загрузка актуального списка зеркал из удалённого источника. */
export async function refreshRemoteInstancePool(): Promise<string[]> {
  if (remotePool.length && Date.now() - remotePoolLoadedAt < REMOTE_POOL_TTL_MS) return remotePool;
  for (const src of REMOTE_POOL_SOURCES) {
    try {
      const res = await fetchWithTimeout(src, 6000);
      if (!res.ok) continue;
      const urls = parseInstanceList(await res.text());
      if (urls.length > 0) {
        remotePool = urls;
        remotePoolLoadedAt = Date.now();
        console.log(`[JacRed] Динамический пул загружен (${urls.length} зеркал) из ${src}`);
        return urls;
      }
    } catch { /* источник недоступен — пробуем следующий */ }
  }
  console.warn('[JacRed] Удалённый список зеркал недоступен — использую дефолтный пул');
  return getInstancePool();
}

/** Принудительно очистить динамический пул (например, при смене настроек). */
export function resetRemoteInstancePool() {
  remotePool = [];
  remotePoolLoadedAt = 0;
}

/** Трекеры, по которым фильтруем выдачу (имена модулей JacRed).
 *  1337x и NYAA — публичные, без логина; RuTracker/NNM-Club — при наличии кредов. */
export const JACRED_TRACKERS = ['RuTracker.org', 'NNM-Club', 'Rutor', '1337x', 'NYAA'] as const;

/** Переопределение пула пользователем: JSON-массив base-URL в localStorage. */
const OVERRIDE_KEY = 'luminary_jacred_instances';

/** Пользовательский инстанс из настроек UI (приоритетнее пула/localStorage). */
let customInstance = '';
export function setCustomJacredUrl(url: string) {
  customInstance = (url || '').trim().replace(/\/+$/, '');
}

/**
 * Локальный встроенный JacRed (Zero-Config: бинарник, spawn в Main Process).
 * Приоритет №1 — всегда опрашивается первым (самый быстрый и надёжный).
 * Передайте '' — инстанс остановлен, исключается из пула.
 */
let localInstance = '';
export function setLocalJacredUrl(url: string) {
  localInstance = (url || '').trim().replace(/\/+$/, '');
}

function getInstancePool(): string[] {
  const pool: string[] = [];
  // 1) Локальный встроенный JacRed — первым (быстрее и надёжнее публичных)
  if (localInstance) pool.push(localInstance);
  // 2) Пользовательский инстанс из настроек UI
  if (customInstance) pool.push(customInstance);
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        pool.push(
          ...parsed
            .map((s) => String(s).replace(/\/+$/, ''))
            .filter((s) => /^https?:\/\//i.test(s))
        );
      }
    }
  } catch { /* ignore */ }
  // Динамический пул (remote CDN/Gist), затем дефолтный — в хвост, как резерв
  pool.push(...remotePool.filter((b) => !pool.includes(b)));
  pool.push(...JACRED_INSTANCES.filter((b) => !pool.includes(b)));
  return pool;
}

/** Статус последнего поиска JacRed: ok — хотя бы один инстанс ответил;
 *  unreachable — все зеркала недоступны (для плашки «RuTracker офлайн»). */
let lastStatus: 'ok' | 'unreachable' = 'ok';
export function getJacredStatus(): 'ok' | 'unreachable' {
  return lastStatus;
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
  if (/субтитры|субтитровано|subbed|суб/i.test(title)) return 'Оригинал + Субтитры';
  return 'Прочее';
}

/** Короткое имя трекера: RuTracker.org → RuTracker, 1337x → 1337x. */
function normalizeTracker(tracker: string): string {
  const t = String(tracker || '').trim();
  if (/rutracker/i.test(t)) return 'RuTracker';
  if (/nnm/i.test(t)) return 'NNM';
  if (/^rutor$/i.test(t)) return 'Rutor';
  if (/^bitru$/i.test(t)) return 'Bitru';
  if (/torrentby|torrent\.by/i.test(t)) return 'TorrentBy';
  if (/kinozal/i.test(t)) return 'Kinozal';
  if (/1337x/i.test(t)) return '1337x';
  if (/nyaa/i.test(t)) return 'NYAA';
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
 * Построить URL поиска для инстанса.
 *
 * Локальный встроенный JacRed — это форк jacred-fdb (v3.4.x): у него
 * классический /api/v1/search является Prowlarr-фидом (пустым без настроек),
 * а Lampa-совместимый поиск живёт на Jackett-эндпоинте
 * /api/v2.0/indexers/all/results (Response: { Results: [...] } с MagnetUri).
 * Именно его использует Lampa с этим форком — поэтому локальный инстанс
 * опрашиваем тем же путём. Публичные классические инстансы — /api/v1/search.
 */
function buildSearchUrl(base: string, query: string, year?: string): string {
  const isLocal = base === localInstance;
  const p = new URLSearchParams(
    isLocal ? { Query: query.slice(0, 200) } : { query: query.slice(0, 200) }
  );
  if (year) p.set('year', String(year).slice(0, 4));
  if (isLocal) {
    // Локальная БД наполняется всеми модулями (rutor/bitru/torrentby/kinozal),
    // фильтр по трекерам не применяем — трекер виден в поле Tracker раздачи.
    p.set('limit', '200');
    return `${base}/api/v2.0/indexers/all/results?${p.toString()}`;
  }
  // Классические инстансы: поиск по трекерам RuTracker/NNM-Club/Rutor
  p.set('trackers', JACRED_TRACKERS.join(','));
  return `${base}/api/v1/search?${p.toString()}`;
}

/**
 * Запрос к одному инстансу. Возвращает раздачи, [] — инстанс жив, но пусто,
 * null — инстанс упал (ошибка/таймаут/невалидный ответ) → карантин.
 */
async function queryInstance(base: string, query: string, year?: string): Promise<TorrentRelease[] | null> {
  const url = buildSearchUrl(base, query, year);
  try {
    const res = await fetchWithTimeout(url, INSTANCE_TIMEOUT_MS);
    if (!res.ok) {
      markDead(base);
      console.warn(`[JacRed] ${base} → HTTP ${res.status}`);
      return null;
    }
    let payload: any;
    try {
      payload = await res.json();
    } catch {
      markDead(base);
      console.warn(`[JacRed] ${base} → invalid JSON`);
      return null;
    }
    // success:false — инстанс отвечает, но поиск/трекеры недоступны → карантин
    if (payload && payload.success === false) {
      markDead(base);
      console.warn(`[JacRed] ${base} → ${String(payload.error || 'search failed')}`);
      return null;
    }
    markAlive(base);
    return parseItems(payload, query);
  } catch (err: any) {
    markDead(base);
    console.warn(`[JacRed] ${base} failed: ${err?.message || err}`);
    return null;
  }
}

/**
 * Поиск раздач через JacRed: ПАРАЛЛЕЛЬНЫЙ опрос всех живых зеркал (racing
 * query / fast-failover) — ни один мёртвый инстанс не блокирует выдачу.
 * Результаты всех ответивших объединяются с дедупом по BTIH и сортировкой
 * 4K/2160p → 1080p. Упавшие зеркала автоматически уходят в карантин.
 */
export async function searchJacRed(
  query: string,
  year?: string
): Promise<TorrentRelease[]> {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return [];

  const pool = getInstancePool().filter((b) => !isDead(b));
  if (pool.length === 0) {
    lastStatus = 'unreachable';
    return [];
  }

  // Параллельный опрос всего пула; общий дедлайн ограничивает ожидание
  const results = await Promise.allSettled(
    pool.map((base) => queryInstance(base, q, year))
  );

  const merged = mergeReleasesByHash(
    pool
      .map((base, i) => {
        const r = results[i];
        return r.status === 'fulfilled' && r.value ? r.value : [];
      })
      .flat()
  );

  lastStatus = results.some((r) => r.status === 'fulfilled' && r.value !== null) ? 'ok' : 'unreachable';
  return merged;
}

/**
 * Racing probe: параллельный ping всех зеркал (поиск 'test') для быстрого
 * определения живых/мёртвых на старте приложения — первый поиск не ждёт
 * таймауты мёртвых инстансов (они сразу уходят в карантин).
 */
export async function probeJacredPool(): Promise<{ alive: number; dead: number }> {
  const pool = getInstancePool();
  const results = await Promise.allSettled(pool.map((base) => queryInstance(base, 'test')));
  const alive = results.filter((r) => r.status === 'fulfilled' && r.value !== null).length;
  const dead = pool.length - alive;
  console.log(`[JacRed] Racing probe: ${alive} alive, ${dead} dead (из ${pool.length})`);
  return { alive, dead };
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
