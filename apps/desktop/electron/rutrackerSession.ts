/**
 * rutrackerSession.ts — встроенный браузерный сеанс RuTracker (Zero-Config).
 *
 * Проблема: rutracker.org закрыт Cloudflare-челленджем для любых HTTP-клиентов
 * (включая парсер локального JacRed — он физически не может залогиниться и
 * собрать магнеты; nnmclub.to без защиты — работает). Решение — РЕАЛЬНЫЙ браузер:
 *
 *  - Скрытое окно Electron грузит rutracker.org → исполняет JS-челлендж
 *    Cloudflare → cf_clearance в сессии.
 *  - Поиск выполняется ЧЕРЕЗ ОКНО (window.fetch из контекста страницы) —
 *    Cloudflare не челленджит браузерный fetch с полными cookies (проверено
 *    live: гостевой поиск отдаёт реальную страницу).
 *  - Вход — ВИДИМОЕ окно в приложении (как на сайте: JS-форма rutracker не
 *    принимает программную отправку — проверено live). После входа bb_session
 *    появляется в сессии → поиск отдаёт строки с магнетами.
 *
 * Результат поиска — TorrentRelease[] (title/BTIH/size/seeders), уходит в общий
 * поток мёрджа в renderer (src/services/torrserver.ts, дедуп по BTIH).
 */

import { BrowserWindow, session } from 'electron';
import { createHash } from 'crypto';
import { TorrentScraper, TorrentRelease } from './scraper.js';

const PARTITION = 'persist:rutracker';
/** Fallback-цепочка доменов RuTracker: основной org + зеркала. Если один домен
 *  недоступен/заблокирован (CF-челлендж не проходит, DNS мёртв) — поиск
 *  автоматически пробует следующий. Проверено live: .net живой (CF), .nl живой
 *  (JS-редирект на рабочий домен — браузер окна проходит его сам). */
const SITES = ['https://rutracker.org', 'https://rutracker.net', 'https://rutracker.nl'];
/** Сколько результатов отдаём за один поиск. */
const MAX_RESULTS = 12;
/** Время жизни кэша раздач (повторные открытия фильма — без навигации). */
const SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;
/** Пустой результат кэшируем НЕДОЛГО: раздачи могли появиться, но повторные
 *  открытия не должны молотить Cloudflare-челленджи по 40с. */
const EMPTY_CACHE_TTL_MS = 3 * 60 * 1000;

/** Извлечение строк поиска tracker.php прямо в окне (без парсинга HTML в main). */
const EXTRACT_ROWS_JS = `(() => {
  const out = [];
  for (const tr of document.querySelectorAll('tr.tCenter.hl-tr, tr.tCenter')) {
    const titleEl = tr.querySelector('a.med.tLink, a.tLink');
    const dl = tr.querySelector('a[href^="dl.php"]');
    if (!titleEl || !dl) continue;
    const topicA = tr.querySelector('a[href*="viewtopic.php?t="]');
    const m = topicA ? (topicA.href || '').match(/t=([0-9]+)/) : null;
    if (!m) continue;
    out.push({
      title: titleEl.textContent.trim(),
      topicId: m[1],
      size: (dl.textContent || '').trim(),
      seeders: parseInt(((tr.querySelector('b.seedmed, span.seedmed') || {}).textContent || '0').replace(/[^0-9]/g, ''), 10) || 0,
      leechers: parseInt(((tr.querySelector('b.leechmed, span.leechmed') || {}).textContent || '0').replace(/[^0-9]/g, ''), 10) || 0,
    });
  }
  return out.slice(0, 30);
})()`;

export interface RutrackerSessionStatus {
  loggedIn: boolean;
  /** Видимое окно входа открыто (пользователь логинится прямо сейчас). */
  loginWindowOpen: boolean;
}

export class RutrackerSessionManager {
  /** Кэш найденных раздач по запросу — стабильность при перезаходах в список. */
  private searchCache = new Map<string, { releases: TorrentRelease[]; at: number }>();
  /** Активный домен из fallback-цепочки SITES (переключается при недоступности). */
  private siteIndex = 0;
  private site(): string {
    return SITES[this.siteIndex % SITES.length];
  }
  /** Переключиться на следующий домен (fallback при провале навигации). */
  private nextSite(): void {
    this.siteIndex = (this.siteIndex + 1) % SITES.length;
    console.log(`[RutrackerSession] Переключение на зеркало: ${this.site()}`);
  }
  /** Последовательная очередь поисков: одно окно, навигации не конфликтуют. */
  private searchChain: Promise<unknown> = Promise.resolve();
  private win: BrowserWindow | null = null;
  private visible = false;
  private lastLoggedIn: boolean | null = null;
  private watcherTimer: NodeJS.Timeout | null = null;
  private loginListener: ((loggedIn: boolean) => void) | null = null;
  private readonly scraper = new TorrentScraper();

  private ses() {
    return session.fromPartition(PARTITION);
  }

  /** Уведомление renderer'а при смене состояния входа (bb_session появился/пропал). */
  public setLoginListener(fn: (loggedIn: boolean) => void) {
    this.loginListener = fn;
  }

  private async ensureWindow(visible: boolean): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed()) {
      if (visible && !this.visible) {
        this.win.show();
        this.win.focus();
        this.visible = true;
      }
      return this.win;
    }
    this.win = new BrowserWindow({
      show: visible,
      width: 1150,
      height: 850,
      title: 'RuTracker — вход',
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
      },
    });
    this.visible = visible;
    this.win.on('closed', () => {
      this.win = null;
      this.visible = false;
    });
    return this.win;
  }

  /** loadURL с таймаутом (LoadURLOptions не поддерживает timeout в этой версии). */
  private loadWithTimeout(win: BrowserWindow, url: string): Promise<void> {
    return Promise.race([
      win.loadURL(url),
      new Promise<void>((resolve) => setTimeout(resolve, 30000)),
    ]);
  }

  /**
   * Разогрев сессии: скрытое окно грузит rutracker.org — проходим
   * Cloudflare-челлендж (JS исполняется в окне) и получаем cf_clearance.
   */
  public async ensureSession(): Promise<void> {
    try {
      const win = await this.ensureWindow(false);
      await this.loadWithTimeout(win, `${this.site()}/forum/index.php`);
      // Ждём завершения загрузки (до 5 с) — executeJavaScript на ещё грузящемся
      // окне висит ВЕЧНО (проверено live), а это блокирует поиск.
      for (let i = 0; i < 10 && win.webContents.isLoading(); i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
      // Даём челленджу выполниться и установить cookies
      await new Promise((r) => setTimeout(r, 4000));
    } catch { /* сети нет — окно переживёт повторные попытки */ }
    this.startWatcher();
  }

  /** Сессия вошла: в cookie-хранилище есть bb_session. */
  public async isLoggedIn(): Promise<boolean> {
    try {
      const cookies = await this.ses().cookies.get({});
      return cookies.some((c) => c.name === 'bb_session' && !!c.value);
    } catch {
      return false;
    }
  }

  public async getStatus(): Promise<RutrackerSessionStatus> {
    return {
      loggedIn: await this.isLoggedIn(),
      loginWindowOpen: this.visible,
    };
  }

  /**
   * Открыть ВИДИМОЕ окно входа (как сайт). Пользователь логинится сам —
   * это единственный надёжный путь (JS-форма rutracker не принимает
   * программные сабмиты; проверено live). После входа watcher заметит
   * bb_session и уведомит renderer.
   */
  public async openLoginWindow(): Promise<RutrackerSessionStatus> {
    const win = await this.ensureWindow(true);
    try {
      await this.loadWithTimeout(win, `${this.site()}/forum/login.php`);
    } catch { /* сеть может быть недоступна */ }
    this.startWatcher();
    return this.getStatus();
  }

  /** Скрыть окно входа (сессия сохраняется). */
  public async hideLoginWindow(): Promise<void> {
    if (this.win && this.visible) {
      this.win.hide();
      this.visible = false;
    }
  }

  /** Наблюдатель за bb_session (раз в 4 с) → push в renderer. */
  private startWatcher() {
    if (this.watcherTimer) return;
    const tick = async () => {
      const logged = await this.isLoggedIn();
      if (logged !== this.lastLoggedIn) {
        this.lastLoggedIn = logged;
        this.loginListener?.(logged);
      }
    };
    tick().catch(() => {});
    this.watcherTimer = setInterval(() => {
      tick().catch(() => {});
    }, 4000);
  }

  /**
   * Поиск раздач через НАВИГАЦИЮ окна (не fetch!). Современный rutracker:
   *  - Cloudflare челленджит fetch-запросы даже с валидной сессией (проверено
   *    live: «Один момент…»), а навигация окна проходит — JS-челлендж
   *    исполняется браузером (первый раз ~7-8 с, дальше клиренс тёплый);
   *  - magnet-ссылок в списке результатов БОЛЬШЕ НЕТ (только dl.php?t=<id>) —
   *    магнет лежит на странице темы viewtopic.php?t=<id> (проверено live).
   * Поэтому: tracker.php → строки → для top-N тем навигация → magnet.
   * Таймауты на каждом шаге — окно НИКОГДА не блокирует выдачу.
   */
  public async search(query: string, year?: string, fallbackQuery?: string): Promise<TorrentRelease[]> {
    // Кэш: найденные раздачи возвращаются МГНОВЕННО при повторном открытии
    // фильма — Cloudflare-флак (челлендж «раз через раз») больше не приводит
    // к «rutracker то есть, то нет» при перезаходах в список раздач.
    const cacheKey = `${query}|${year || ''}|${fallbackQuery || ''}`;
    const hit = this.searchCache.get(cacheKey);
    if (hit) {
      const ttl = hit.releases.length > 0 ? SEARCH_CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
      if (Date.now() - hit.at < ttl) {
        console.log(`[RutrackerSession] кэш: ${hit.releases.length} раздач для "${query}"`);
        return hit.releases;
      }
    }

    // Очередь: окно одно — параллельные навигации (быстрое переключение
    // фильмов) ломают друг друга («раз через раз»). Поиски идут строго
    // последовательно; кэш делает повторные открытия мгновенными.
    const run = (skipCache: boolean) => this.searchImpl(query, year, fallbackQuery, cacheKey, skipCache);
    let result: TorrentRelease[] = [];
    const enqueue = (task: Promise<void>) => {
      const chained = this.searchChain.then(() => task);
      this.searchChain = chained.catch(() => {});
      return chained;
    };
    await enqueue((async () => { result = await run(false); })());

    // ГАРАНТИЯ «rutracker в любом сценарии»: пустой результат РЕАЛЬНОГО
    // прохода (кэш-хит вернулся бы выше) — почти всегда CF-челлендж с нуля
    // не уложился в бюджет (клиренс протух за ~30 мин простоя). Повторный
    // проход идёт с уже прогретым клиренсом и обычно занимает секунды.
    // Один повтор; свежий кэш пустых (3 мин) защищает от повторов, когда
    // раздач реально нет.
    if (result.length === 0) {
      console.log('[RutrackerSession] первый проход пуст — повторный заход на сайт');
      await enqueue((async () => { result = await run(true); })());
      if (result.length > 0) {
        console.log(`[RutrackerSession] повторный проход дал ${result.length} раздач`);
      }
    }
    return result;
  }

  /** Реализация поиска (вызывается из очереди, см. search). */
  private async searchImpl(
    query: string,
    year?: string,
    fallbackQuery?: string,
    cacheKey: string = '',
    skipCache: boolean = false
  ): Promise<TorrentRelease[]> {
    if (!skipCache) {
      const hit = this.searchCache.get(cacheKey);
      if (hit) {
        const ttl = hit.releases.length > 0 ? SEARCH_CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
        if (Date.now() - hit.at < ttl) return hit.releases;
      }
    }
    const win = await this.ensureWindow(false);
    const searchStr = year ? `${query} ${year}` : query;
    const q = encodeURIComponent(searchStr);
    const tStart = Date.now();
    /** Общий дедлайн поиска: темы/скрипты не должны держать выдачу минутами. */
    const DEADLINE_MS = 60000;
    try {
      // 1) Страница поиска (навигация + ожидание прохождения челленджа).
      //    Челлендж Cloudflare флакает — до 2 повторных попыток навигации.
      //    Первой попытке даём 25с: челлендж С НУЛЯ (клиренс протух за время
      //    простоя) занимает 10-20с, таймаут 12с его обрезал → «rutracker
      //    раз через раз пропадает».
      let okSearch = false;
      for (let attempt = 0; attempt < 3 && !okSearch; attempt++) {
        if (attempt > 0) {
          console.warn(`[RutrackerSession] попытка ${attempt + 1}: повторная навигация на поиск`);
          await new Promise((r) => setTimeout(r, 2000));
        }
        okSearch = await this.navigate(win, `${this.site()}/forum/tracker.php?nm=${q}`, attempt === 0 ? 25000 : 12000);
      }
      // Fallback-цепочка: домен не отвечает (CF-блокировка/DNS) — пробуем
      // следующее зеркало из SITES (org → net → nl) ещё парой попыток.
      if (!okSearch && SITES.length > 1) {
        this.nextSite();
        for (let attempt = 0; attempt < 2 && !okSearch; attempt++) {
          if (attempt > 0) {
            console.warn('[RutrackerSession] повторная навигация на зеркале');
            await new Promise((r) => setTimeout(r, 2000));
          }
          okSearch = await this.navigate(win, `${this.site()}/forum/tracker.php?nm=${q}`, 12000);
        }
      }
      console.log(`[RutrackerSession] t+${((Date.now() - tStart) / 1000).toFixed(1)}с: поиск ок=${okSearch}`);
      if (!okSearch) {
        console.warn('[RutrackerSession] страница поиска не загрузилась (челлендж/сеть)');
        return [];
      }
      let rows: Array<{ title: string; topicId: string; size: string; seeders: number; leechers: number }> =
        await this.execWithTimeout(win, EXTRACT_ROWS_JS, 5000).catch(() => []);

      // 2) Проход по ОРИГИНАЛЬНОМУ названию — ВСЕГДА (не только при пустом
      //    RU-поиске): 4К-рипы на rutracker часто называются ТОЛЬКО латиницей
      //    («Spider-Man: No Way Home 4K UHD…») и не находятся по русскому.
      //    Результаты объединяются с дедупом по topicId.
      if (fallbackQuery && fallbackQuery.toLowerCase() !== query.toLowerCase()) {
        console.log(`[RutrackerSession] проход по оригиналу: "${fallbackQuery}"`);
        const okEn = await this.navigate(
          win,
          `${this.site()}/forum/tracker.php?nm=${encodeURIComponent(fallbackQuery)}`,
          10000
        );
        if (okEn) {
          const enRows: Array<{ title: string; topicId: string; size: string; seeders: number; leechers: number }> =
            await this.execWithTimeout(win, EXTRACT_ROWS_JS, 5000).catch(() => []);
          if (enRows.length > 0) {
            const seen = new Set(rows.map((r) => r.topicId));
            rows = [...rows, ...enRows.filter((r) => !seen.has(r.topicId))];
            console.log(`[RutrackerSession] всего строк после мёржа RU+EN: ${rows.length}`);
          }
        }
      }
      if (!rows.length) return [];

      // Ранжирование тем: НЕ порядок трекера (сверху свежие перезаливы), а
      // качество (4К → 1080p → 720p → SD) + сиды. Иначе 4К-раздача с 49 сидами,
      // стоящая 8-й в списке, никогда не попадёт в выдачу (пример t=6304483).
      const ranked = rows
        .map((r) => ({ ...r, rankScore: this.qualityRank(r.title) + r.seeders }))
        .sort((a, b) => b.rankScore - a.rankScore);

      // 2) Темы top-N: .torrent через dl.php (fetch со страницы поиска) —
      //    БЕЗ навигации на viewtopic: Cloudflare тормозит навигации на темы
      //    (30-225с, проверено live), а dl.php с той же сессии — 200мс.
      const releases: TorrentRelease[] = [];
      for (const row of ranked.slice(0, 8)) {
        if (!row.topicId) continue;
        if (Date.now() - tStart > DEADLINE_MS) break;
        const budget = Math.min(9000, DEADLINE_MS - (Date.now() - tStart));
        const rel = await Promise.race<TorrentRelease | null>([
          this.collectFromDl(win, row).catch(() => null),
          new Promise<TorrentRelease | null>((resolve) => setTimeout(() => resolve(null), budget)),
        ]);
        if (rel) {
          releases.push(rel);
          if (releases.length >= MAX_RESULTS) break;
        }
      }
      if (Date.now() - tStart > DEADLINE_MS) {
        console.warn(`[RutrackerSession] дедлайн ${DEADLINE_MS}мс истёк — вернул ${releases.length} раздач`);
      }
      this.searchCache.set(cacheKey, { releases, at: Date.now() });
      if (this.searchCache.size > 30) {
        // вытесняем самый старый ключ
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [k, v] of this.searchCache) {
          if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
        }
        if (oldestKey) this.searchCache.delete(oldestKey);
      }
      return releases;
    } catch (err: any) {
      console.warn('[RutrackerSession] search failed:', err?.message || err);
      return [];
    }
  }

  /**
   * Собрать раздачу БЕЗ навигации на тему: dl.php отдаёт .torrent прямо со
   * страницы поиска (та же сессия, Cloudflare не челленджит — проверено live:
   * 200мс против 225с навигации на viewtopic). BTIH вычисляем из файла.
   */
  private async collectFromDl(
    win: BrowserWindow,
    row: { title: string; topicId: string; size: string; seeders: number; leechers: number }
  ): Promise<TorrentRelease | null> {
    const torrentB64: string = await this.execWithTimeout(
      win,
      `fetch('/forum/dl.php?t=${row.topicId}', { credentials: 'include' }).then(async (r) => {
         const buf = await r.arrayBuffer();
         if (!buf || buf.byteLength < 1000) return '';
         const bytes = new Uint8Array(buf);
         let bin = '';
         for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
         return btoa(bin);
       })`,
      8000
    ).catch(() => '');
    if (!torrentB64) return null;
    const btih = btihFromTorrent(torrentB64);
    if (!btih) return null;
    const rel = this.scraper.normalize(
      row.title,
      `magnet:?xt=urn:btih:${btih}&dn=${encodeURIComponent(row.title)}`,
      this.parseSizeBytes(row.size),
      row.seeders || 0,
      row.leechers || 0,
      'RuTracker'
    );
    rel.torrentFile = torrentB64;
    return rel;
  }

  /** executeJavaScript с жёстким таймаутом — на ещё грузящемся окне он висит вечно. */
  private async execWithTimeout(win: BrowserWindow, code: string, ms: number): Promise<any> {
    return await Promise.race([
      win.webContents.executeJavaScript(code),
      new Promise<any>((resolve) => setTimeout(() => resolve(''), ms)),
    ]);
  }

  /** Навигация + ожидание завершения Cloudflare-челленджа (до maxS секунд). */
  private async navigate(win: BrowserWindow, url: string, maxS: number): Promise<boolean> {
    await Promise.race([
      win.loadURL(url).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, maxS * 1000)),
    ]);
    for (let i = 0; i < maxS * 2; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (win.webContents.isLoading()) continue;
      // Таймаут ОБЯЗАТЕЛЕН: на pending-load окне executeJavaScript висит
      // ~30с (проверено live) — без race навигация затягивает весь поиск.
      const title = await this.execWithTimeout(win, 'document.title', 3000).catch(() => '');
      // «Just a moment…» / «Один момент…» — челлендж ещё идёт
      if (title && !/момент|moment/i.test(title)) return true;
    }
    return false;
  }

  /** Вес качества для ранжирования тем: 4К → 1080p → 720p → SD. */
  private qualityRank(title: string): number {
    const t = title.toLowerCase();
    if (/\b2160p\b|\b4k\b|\buhd\b|\b3840\s*[x×]\s*2160\b/.test(t)) return 3000;
    if (/\b1080p\b|\b1080i\b|\bfull.?hd\b|\b1920\s*[x×]\s*1080\b/.test(t)) return 1000;
    if (/\b720p\b|\b1280\s*[x×]\s*720\b/.test(t)) return 300;
    return 0;
  }

  private parseSizeBytes(sizeStr: string): number {
    const m = String(sizeStr).match(/([\d.]+)\s*(GB|MB|KB|TB|ГБ|МБ|КБ|ТБ)/i);
    if (!m) return 4 * 1024 * 1024 * 1024;
    const val = parseFloat(m[1]);
    if (!Number.isFinite(val) || val < 0) return 4 * 1024 * 1024 * 1024;
    const unit = m[2].toUpperCase();
    if (unit.startsWith('T') || unit.startsWith('Т')) return val * 1024 * 1024 * 1024 * 1024;
    if (unit.startsWith('G') || unit.startsWith('Г')) return val * 1024 * 1024 * 1024;
    if (unit.startsWith('M') || unit.startsWith('М')) return val * 1024 * 1024;
    return val * 1024;
  }

  /** Очистка при выходе из приложения. */
  public destroy() {
    if (this.watcherTimer) {
      clearInterval(this.watcherTimer);
      this.watcherTimer = null;
    }
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }
}

// ═══════════════════════════════════════════════════════
//  BTIH из .torrent-файла (bencode → SHA1(info-словаря)).
//  Позволяет строить magnet без навигации на тему —
//  достаточно dl.php (200мс), который отдаёт .torrent.
// ═══════════════════════════════════════════════════════
export function btihFromTorrent(base64: string): string {
  try {
    const buf = Buffer.from(base64, 'base64');
    const infoKey = Buffer.from('4:info');
    const idx = buf.indexOf(infoKey);
    if (idx < 0) return '';
    const start = idx + infoKey.length;
    const end = findBencodeValueEnd(buf, start);
    if (end <= start) return '';
    return createHash('sha1').update(buf.subarray(start, end)).digest('hex');
  } catch {
    return '';
  }
}

/** Конец bencode-значения (словаря/списка/строки/числа), позиция ПОСЛЕ него. */
function findBencodeValueEnd(buf: Buffer, pos: number): number {
  const parseValue = (p: number): number => {
    const c = buf[p];
    if (c === 0x64) { // d
      p++;
      while (buf[p] !== undefined && buf[p] !== 0x65) {
        const keyEnd = parseStringEnd(buf, p);
        if (keyEnd < 0) return -1;
        const valEnd = parseValue(keyEnd);
        if (valEnd < 0) return -1;
        p = valEnd;
      }
      return buf[p] === 0x65 ? p + 1 : -1;
    }
    if (c === 0x6c) { // l
      p++;
      while (buf[p] !== undefined && buf[p] !== 0x65) {
        const itemEnd = parseValue(p);
        if (itemEnd < 0) return -1;
        p = itemEnd;
      }
      return buf[p] === 0x65 ? p + 1 : -1;
    }
    if (c === 0x69) { // i<num>e
      const e = buf.indexOf(0x65, p);
      return e < 0 ? -1 : e + 1;
    }
    return parseStringEnd(buf, p);
  };
  return parseValue(pos);
}

/** Конец bencode-строки "len:data". */
function parseStringEnd(buf: Buffer, pos: number): number {
  const colon = buf.indexOf(0x3a, pos);
  if (colon < 0) return -1;
  const len = parseInt(buf.subarray(pos, colon).toString('latin1'), 10);
  if (!Number.isFinite(len) || len < 0) return -1;
  return colon + 1 + len;
}
