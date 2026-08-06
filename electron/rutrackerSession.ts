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
import { TorrentScraper, TorrentRelease } from './scraper.js';

const PARTITION = 'persist:rutracker';
const SITE = 'https://rutracker.org';
/** Сколько результатов отдаём за один поиск. */
const MAX_RESULTS = 12;

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
  return out.slice(0, 10);
})()`;

export interface RutrackerSessionStatus {
  loggedIn: boolean;
  /** Видимое окно входа открыто (пользователь логинится прямо сейчас). */
  loginWindowOpen: boolean;
}

export class RutrackerSessionManager {
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
      await this.loadWithTimeout(win, `${SITE}/forum/index.php`);
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
      await this.loadWithTimeout(win, `${SITE}/forum/login.php`);
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
  public async search(query: string, year?: string): Promise<TorrentRelease[]> {
    const win = await this.ensureWindow(false);
    const searchStr = year ? `${query} ${year}` : query;
    const q = encodeURIComponent(searchStr);
    try {
      // 1) Страница поиска (навигация + ожидание прохождения челленджа)
      const okSearch = await this.navigate(win, `${SITE}/forum/tracker.php?nm=${q}`, 20000);
      if (!okSearch) {
        console.warn('[RutrackerSession] страница поиска не загрузилась (челлендж/сеть)');
        return [];
      }
      const rows: Array<{ title: string; topicId: string; size: string; seeders: number; leechers: number }> =
        await win.webContents.executeJavaScript(EXTRACT_ROWS_JS).catch(() => []);
      if (!rows.length) return [];

      // 2) Темы top-N: навигация → магнет
      const releases: TorrentRelease[] = [];
      for (const row of rows.slice(0, 6)) {
        if (!row.topicId) continue;
        const okTopic = await this.navigate(win, `${SITE}/forum/viewtopic.php?t=${row.topicId}`, 15000);
        if (!okTopic) continue;
        const magnet: string = await win.webContents
          .executeJavaScript(
            `(() => { const a = document.querySelector('a[href^="magnet:"]'); return a ? a.href : ''; })()`
          )
          .catch(() => '');
        if (!/^magnet:\?xt=urn:btih:/i.test(magnet)) continue;
        const rel = this.scraper.normalize(
          row.title,
          magnet,
          this.parseSizeBytes(row.size),
          row.seeders || 0,
          row.leechers || 0,
          'RuTracker'
        );
        // .torrent-файл темы (dl.php с сессией) — надёжнее магнета: метаданные
        // локально, без обмена метаданными через пиров (магнеты в этой сборке
        // TorrServer часто застревают на этапе metadata exchange).
        const torrentB64: string = await win.webContents
          .executeJavaScript(
            `fetch('/forum/dl.php?t=${row.topicId}', { credentials: 'include' }).then(async (r) => {
               const buf = await r.arrayBuffer();
               if (!buf || buf.byteLength < 1000) return '';
               const bytes = new Uint8Array(buf);
               let bin = '';
               for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
               return btoa(bin);
             })`
          )
          .catch(() => '');
        if (torrentB64) rel.torrentFile = torrentB64;
        releases.push(rel);
        if (releases.length >= MAX_RESULTS) break;
      }
      return releases;
    } catch (err: any) {
      console.warn('[RutrackerSession] search failed:', err?.message || err);
      return [];
    }
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
      const title = await win.webContents.executeJavaScript('document.title').catch(() => '');
      // «Just a moment…» / «Один момент…» — челлендж ещё идёт
      if (title && !/момент|moment/i.test(title)) return true;
    }
    return false;
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
