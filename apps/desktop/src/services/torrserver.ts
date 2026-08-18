import { TorrServerStatusInfo, TorrentRelease, TorrServerStats } from '../types';
import { searchJacRed, mergeReleasesByHash, getJacredStatus } from './scrapers/jacred';
import { getBridge } from '../utils/bridge';

/** TorrServer Action=0 historically returned either an object or a one-item
 * array. Normalize both shapes at the renderer boundary. */
function normalizeTorrentResponse(response: any): any {
  const payload = response?.data ?? response;
  const data = Array.isArray(payload) ? payload[0] : payload;
  if (!data || typeof data !== 'object') return response;
  return { ...(response && typeof response === 'object' ? response : {}), success: response?.success !== false, data };
}

export class TorrServerService {
  private reconnectInFlight = new Map<string, Promise<any>>();
  private resetNetworkInFlight: Promise<void> | null = null;

  /** Кэш префетча: magnet → { hash, at }. При открытии фильма тихо add
   *  лучшей раздачи, чтобы «Смотреть» стало мгновенным. hash берётся из
   *  addTorrentFile/addMagnet ответа и переиспользуется в PlayerModal. */
  private prefetchMap = new Map<string, { hash: string; at: number }>();
  /** Время жизни кэша префетча (15 мин — хватает на «порядок чтения» фильма). */
  private static PREFETCH_TTL_MS = 15 * 60 * 1000;

  /** Проверить, не устарел ли кэш префетча (очистка при превышении TTL). */
  private cleanPrefetch(): void {
    if (this.prefetchMap.size <= 10) return;
    const now = Date.now();
    for (const [k, v] of this.prefetchMap) {
      if (now - v.at > TorrServerService.PREFETCH_TTL_MS) this.prefetchMap.delete(k);
    }
  }

  /**
   * Префетч раздачи: тихо добавить в TorrServer (addTorrentFile или addMagnet),
   * запомнить hash. Вызывается из MovieDetailsModal после получения списка
   * раздач — чтобы «Смотреть» было мгновенным при клике.
   * Ошибки игнорируются (сервер может быть не запущен).
   */
  /** Время последнего add от префетча — throttle против шторма (см. prefetch). */
  private lastPrefetchAddAt = 0;
  private static PREFETCH_THROTTLE_MS = 1500;

  public async prefetch(release: TorrentRelease): Promise<void> {
    if (this.prefetchMap.has(release.magnet)) return; // уже префетчено
    this.cleanPrefetch();
    // ЗАЩИТА ОТ ШТОРМА ADD: некоторые пути вызывают prefetch пачками (например,
    // повторные быстрые поиски/мёржи при открытой модалке). Один add раз в 1.5с —
    // лишние пропускаем (hash останется в prefetchMap от ближайшего успешного).
    const now = Date.now();
    if (now - this.lastPrefetchAddAt < TorrServerService.PREFETCH_THROTTLE_MS) return;
    this.lastPrefetchAddAt = now;
    try {
      const res = release.torrentFile
        ? await this.addTorrentFile(release.torrentFile, release.title)
        : await this.addMagnet(release.magnet, release.title);
      if (res?.success || res?.data) {
        const hash = res.data?.hash;
        if (hash) {
          this.prefetchMap.set(release.magnet, { hash, at: Date.now() });
          console.log(`[TorrServerService] prefetch ok: hash=${hash.slice(0,12)} (${release.title.slice(0,40)})`);
          // ПРОГРЕВ: TorrServer не качает без читателя. Открываем /stream —
          // сервер немедленно ищет пиров (DHT/трекеры) и качает первые данные.
          this.warmupStream(hash);
        }
      }
    } catch (err: any) {
      console.warn('[TorrServerService] prefetch failed:', err?.message);
    }
  }

  /** Прогрев потока: открыть /stream и качать циклами (45с → пауза 3 мин),
   *  пока фильм открыт в списке раздач. TorrServer подключает пиров и держит
   *  их «тёплыми» ещё ДО клика «Смотреть» — после клика скорость стартует
   *  сразу, а не с нуля (сценарий «долго открыт фильм в фоне»). */
  private async warmupStream(hash: string): Promise<void> {
    const url = await this.getStreamUrl(hash, 1, false).catch(() => null);
    if (!url) return;
    const cycles = 4; // ~15 минут тёплого качания (45с + 3 мин пауза) × 4
    for (let cycle = 0; cycle < cycles; cycle++) {
      if (cycle > 0) await new Promise((r) => setTimeout(r, 3 * 60 * 1000));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      try {
        const res = await fetch(url, {
          headers: { Range: 'bytes=0-20971520' },
          signal: controller.signal,
        });
        const reader = res.body?.getReader();
        if (reader) {
          while (!controller.signal.aborted) {
            const { done } = await reader.read();
            if (done) break;
          }
          try { reader.releaseLock(); } catch { /* ignore */ }
        }
      } catch {
        /* aborted / сеть — не критично: главное, TorrServer уже ищет пиров */
      }
      clearTimeout(timer);
    }
  }

  /**
   * Взять и удалить из кэша префетча hash для данного magnet (single-use).
   * Если magnet не в кэше или устарел — null (нужен обычный add).
   */
  public consumePrefetch(magnet: string): string | null {
    const hit = this.prefetchMap.get(magnet);
    if (!hit) return null;
    if (Date.now() - hit.at > TorrServerService.PREFETCH_TTL_MS) {
      this.prefetchMap.delete(magnet);
      return null;
    }
    this.prefetchMap.delete(magnet);
    return hit.hash;
  }

  /** Полный сброс сети: пере-анонс DHT/трекеров + reconfigure.
   *  Вызывается при смене IP/списке сети. */
  public async resetNetwork(): Promise<void> {
    if (this.resetNetworkInFlight) return this.resetNetworkInFlight;
    const operation = (async () => {
      try { await (getBridge() as any).resetTorrServerNetwork?.(); } catch { /* ignore */ }
    })();
    this.resetNetworkInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.resetNetworkInFlight === operation) this.resetNetworkInFlight = null;
    }
  }

  /**
   * Подписка на событие смены сети (IP изменился).
   * Вызывает callback с { newIp }. Возвращает функцию отписки.
   */
  public onNetworkChanged(callback: (data: { newIp: string }) => void): () => void {
    const bridge = getBridge();
    if ('onNetworkChanged' in bridge && typeof (bridge as any).onNetworkChanged === 'function') {
      return (bridge as any).onNetworkChanged(callback);
    }
    return () => {};
  }

  /** Подписка на смену статуса TorrServer (running/starting/error). */
  public onStatusChanged(callback: (status: TorrServerStatusInfo) => void): () => void {
    const bridge = getBridge();
    if ('onTorrServerStatusChanged' in bridge && typeof (bridge as any).onTorrServerStatusChanged === 'function') {
      return (bridge as any).onTorrServerStatusChanged(callback);
    }
    return () => {};
  }

  public async getStatus(): Promise<TorrServerStatusInfo> {
    try {
      return await getBridge().getTorrServerStatus();
    } catch {
      return { running: true, port: 8090, version: 'Demo Browser Mode' };
    }
  }

  public async startServer(): Promise<TorrServerStatusInfo> {
    try {
      return await getBridge().startTorrServer();
    } catch {
      return { running: true, port: 8090 };
    }
  }

  public async stopServer(): Promise<{ running: boolean }> {
    try {
      return await getBridge().stopTorrServer();
    } catch {
      return { running: false };
    }
  }

  /** Полный рестарт сервера — самолечение зависшего BT-клиента. */
  public async restartServer(): Promise<TorrServerStatusInfo> {
    try {
      return await getBridge().restartTorrServer();
    } catch {
      return { running: false, port: 8090 };
    }
  }

  public async configureServer(ramCacheMB: number) {
    try { await getBridge().configureTorrServer(ramCacheMB); } catch { /* ignore */ }
  }

  public async dropCache(hash: string) {
    try { await getBridge().dropTorrServerCache(hash); } catch { /* ignore */ }
  }

  /** Переподключение к трекерам/DHT — при пирах>0 и скорости 0.0 MB/s. */
  public async reconnect(hash: string, magnet: string) {
    if (!hash) return { success: false };
    const existing = this.reconnectInFlight.get(hash);
    if (existing) return existing;
    const operation = (async () => {
      try { return await getBridge().reconnectTorrServer(hash, magnet); }
      catch { return { success: true }; }
    })();
    this.reconnectInFlight.set(hash, operation);
    try {
      return await operation;
    } finally {
      if (this.reconnectInFlight.get(hash) === operation) this.reconnectInFlight.delete(hash);
    }
  }

  /** Логи TorrServer (последние N строк) — для панели отладки в настройках. */
  public async getLogs(lines: number = 100): Promise<string[]> {
    try {
      const res = await getBridge().getTorrServerLogs(lines);
      if (res.success) return res.logs;
    } catch { /* ignore */ }
    return [];
  }

  /** Добавить раздачу из .torrent-файла (base64) — приоритетно для rutracker. */
  public async addTorrentFile(base64: string, title?: string) {
    try { return await getBridge().addTorrentFileToTorrServer(base64, title); }
    catch { return { success: false, error: 'addTorrentFile недоступен' }; }
  }

  public async addMagnet(magnet: string, title?: string, poster?: string) {
    try { return await getBridge().addMagnetToTorrServer(magnet, title, poster); }
    catch { return { success: true, data: { hash: 'demo-hash-12345' } }; }
  }

  public async getTorrentStats(hash: string): Promise<{ success: boolean; data?: TorrServerStats; error?: string }> {
    try {
      return normalizeTorrentResponse(await getBridge().getTorrServerTorrent(hash));
    } catch (err: any) {
      // Не подменять недоступную статистику вымышленными пирами/скоростью:
      // это скрывает реальное состояние TorrServer и мешает диагностике.
      return { success: false, error: err?.message || 'Не удалось получить статистику TorrServer' };
    }
  }

  public async getStreamUrl(
    hash: string,
    fileIndex?: number,
    transcodeAudio?: boolean,
    audioIndex?: number
  ): Promise<string> {
    try {
      return await getBridge().getStreamUrl(hash, fileIndex, transcodeAudio, audioIndex);
    } catch {
      return 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4';
    }
  }

  /**
   * Проверка готовности потока + форсирование загрузки.
   * GET с Range: bytes=0-2097151 (2 MB) → ожидаем HTTP 200/206.
   * Большой Range ВАЖЕН: TorrServer не качает данные, пока файл не востребован
   * потоком. Запрос 2 MB заставляет его активно тянуть куски из пиров
   * (иначе даже при пирах>0 скорость держится на 0.0 MB/s).
   * Возвращает content-type — чтобы отличить видео от субтитров.
   */
  public async probeStream(
    url: string,
    timeoutMs = 12000
  ): Promise<{ ok: boolean; status?: number; contentType?: string }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-2097151' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      // Дренируем тело, чтобы соединение закрылось чисто
      res.body?.cancel().catch(() => {});
      return {
        ok: res.status === 200 || res.status === 206,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
      };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Прогреть конкретный диапазон файла перед resume-seek.
   * HLS/GStreamer может запросить сегмент далеко от начала раздачи раньше,
   * чем TorrServer успеет получить соответствующий piece от пиров. Простого
   * probe с Range=0 недостаточно: сервер отвечает, но дальний сегмент остаётся
   * неготовым и HLS застревает в паузе.
   */
  public async warmStreamRange(
    url: string,
    start: number,
    length = 8 * 1024 * 1024,
    timeoutMs = 30000
  ): Promise<boolean> {
    if (!url || !Number.isFinite(start) || start < 0) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const end = Math.max(start, Math.floor(start + Math.max(1, length) - 1));
      const res = await fetch(url, {
        method: 'GET',
        headers: { Range: `bytes=${Math.floor(start)}-${end}` },
        signal: controller.signal,
      });
      if (!(res.status === 200 || res.status === 206)) return false;
      // Читаем диапазон потоково: именно это заставляет TorrServer довести
      // целевой piece до кэша, но не позволяет серверу, проигнорировавшему
      // Range и вернувшему 200, случайно отдать в память весь фильм.
      const reader = res.body?.getReader();
      if (!reader) return false;
      let received = 0;
      while (received < length) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value?.byteLength || 0;
      }
      try { await reader.cancel(); } catch { /* ignore */ }
      return received >= Math.min(length, 1024 * 1024);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  public async searchTorrents(
    query: string,
    year?: string,
    jackettUrl?: string,
    jackettApiKey?: string,
    imdbId?: string,
    fallbackQuery?: string
  ): Promise<{ releases: TorrentRelease[]; error?: string; jacredUnreachable?: boolean }> {
    // Жёсткий дедлайн 8 с на ВЕСЬ поиск: даже если JacRed висит, RuTracker
    // разгоняется, а IPC отвечает медленно — UI гарантированно получит ответ
    // (пусть и пустой) и выйдет из скелетона. См. MovieDetailsModal.isScraping.
    const search = this.searchTorrentsImpl(query, year, jackettUrl, jackettApiKey, imdbId, fallbackQuery);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<{ releases: TorrentRelease[]; error?: string }>((resolve) => {
      deadlineTimer = setTimeout(() => {
        console.warn('[TorrServerService] searchTorrents: дедлайн 8 с истёк — часть источников недоступна');
        resolve({
          releases: [],
          error: 'Поиск занял больше 8 секунд — парсеры временно недоступны. Нажмите «Повторить поиск».',
        });
      }, 8000);
    });
    return await Promise.race([search, deadline]).finally(() => clearTimeout(deadlineTimer));
  }

  /**
   * RuTracker — МЕДЛЕННЫЙ путь (браузерная навигация: Cloudflare-челлендж +
   * темы, обычно 6-15с). Не должен блокировать быстрый поиск и не должен
   * обрезаться его дедлайном — поэтому вызывается фоном (searchRutrackerLate),
   * а его раздачи мёржатся в список реактивно, когда готовы.
   */
  public async searchRutrackerLate(
    query: string,
    year?: string,
    fallbackQuery?: string
  ): Promise<{ releases: TorrentRelease[]; applicable: boolean }> {
    const bridge = getBridge();
    const rutrackerSearch = bridge.rutrackerSearch;
    console.log('[TorrServerService] RuTracker late: старт query="' + query + '" (bridge=' + !!rutrackerSearch + ')');
    if (!rutrackerSearch) return { releases: [], applicable: false };

    const releases = await rutrackerSearch(query, year, fallbackQuery)
      .then((res: any) => (res.success && Array.isArray(res.releases) ? res.releases : []))
      .catch((err: any) => {
        console.warn('[TorrServerService] RuTracker search failed:', err?.message || err);
        return [];
      });
    return { releases, applicable: true };
  }

  private async searchTorrentsImpl(
    query: string,
    year?: string,
    jackettUrl?: string,
    jackettApiKey?: string,
    imdbId?: string,
    fallbackQuery?: string
  ): Promise<{ releases: TorrentRelease[]; error?: string; jacredUnreachable?: boolean }> {
    const bridge = getBridge();
    let ipcErrorMsg: string | undefined;
    const ipcPromise: Promise<TorrentRelease[]> = bridge.searchTorrents
      ? Promise.race<TorrentRelease[]>([
          bridge
            .searchTorrents(query, year, jackettUrl, jackettApiKey, imdbId, fallbackQuery)
            .then((res: any) => {
              if (!res.success) ipcErrorMsg = res.error || 'Не удалось найти торренты';
              return res.success && Array.isArray(res.releases) ? res.releases : [];
            })
            .catch((err: any) => {
              ipcErrorMsg = 'Не удалось выполнить поиск торрентов';
              console.error('[TorrServerService] searchTorrents error:', err);
              return [];
            }),
          new Promise<TorrentRelease[]>((resolve) => setTimeout(() => resolve([]), 8000)),
        ])
      : Promise.resolve([]);

    const jacredPromise = searchJacRed(query, year).catch((err: any) => {
      console.warn('[TorrServerService] JacRed search failed:', err?.message || err);
      return [];
    });

    const [ipcReleases, jacredReleases] = await Promise.all([ipcPromise, jacredPromise]);
    const merged = mergeReleasesByHash(ipcReleases, jacredReleases);
    const jacredUnreachable = getJacredStatus() === 'unreachable';
    if (merged.length > 0) return { releases: merged, jacredUnreachable };

    // Browser demo mode — нет Electron-моста: показываем демо-раздачи
    if (!bridge.searchTorrents) {
      return { releases: this.demoReleases(query, year) };
    }
    return { releases: [], error: ipcErrorMsg || 'Не удалось найти торренты', jacredUnreachable };
  }

  private demoReleases(query: string, year?: string): TorrentRelease[] {
    const gb = (n: number) => n * 1024 * 1024 * 1024;
    return [
      {
        id: 'demo-1',
        title: `${query} ${year || ''} [2160p 4K UHD] [HDR10+ & Dolby Vision] [REMUX] [HEVC] [TrueHD Atmos 7.1] [Дубляж] [RHS] [Rus Sub]`,
        quality: '4K',
        tags: ['Dolby Vision', 'HDR10+', 'REMUX'],
        dubbing: 'RHS',
        size: '77.77 GB',
        sizeBytes: gb(77.77),
        seeders: 512,
        leechers: 31,
        magnet: `magnet:?xt=urn:btih:08da7015a846347d46922970f5b73015db5e9d1&dn=${encodeURIComponent(query)}+4K`,
        source: 'RuTracker (Demo)',
        videoCodec: 'HEVC',
        audioCodec: 'TrueHD',
        stabilityScore: 95,
        stabilityLabel: 'Отличная',
        requiredMbps: 48.2,
      },
      {
        id: 'demo-2',
        title: `${query} ${year || ''} [1080p FullHD] [WEB-DL] [x264] [AC3 5.1] [Озвучка HDRezka Studio]`,
        quality: '1080p',
        tags: ['WEB-DL'],
        dubbing: 'HDRezka',
        size: '6.80 GB',
        sizeBytes: gb(6.8),
        seeders: 340,
        leechers: 18,
        magnet: `magnet:?xt=urn:btih:08da7015a846347d46922970f5b73015db5e9d2&dn=${encodeURIComponent(query)}+1080p`,
        source: 'Rutor Tracker (Demo)',
        videoCodec: 'H.264',
        audioCodec: 'AC3',
        stabilityScore: 96,
        stabilityLabel: 'Отличная',
        requiredMbps: 8.2,
      },
      {
        id: 'demo-3',
        title: `${query} ${year || ''} [1080p] [BDRip] [Дубляж Лицензия] [LostFilm] [Eng Sub]`,
        quality: '1080p',
        tags: ['BDRip'],
        dubbing: 'Дубляж',
        size: '4.20 GB',
        sizeBytes: gb(4.2),
        seeders: 210,
        leechers: 5,
        magnet: `magnet:?xt=urn:btih:08da7015a846347d46922970f5b73015db5e9d3&dn=${encodeURIComponent(query)}+Dub`,
        source: 'Torrentio Network (Demo)',
        videoCodec: 'H.264',
        audioCodec: 'AAC',
        stabilityScore: 88,
        stabilityLabel: 'Отличная',
        requiredMbps: 5.1,
      },
      {
        id: 'demo-4',
        title: `${query} ${year || ''} [720p] [WEBRip] [x264] [2.0] [Оригинал]`,
        quality: '720p',
        tags: ['WEBRip'],
        dubbing: 'Оригинал + Субтитры',
        size: '1.90 GB',
        sizeBytes: gb(1.9),
        seeders: 45,
        leechers: 60,
        magnet: `magnet:?xt=urn:btih:08da7015a846347d46922970f5b73015db5e9d4&dn=${encodeURIComponent(query)}+720p`,
        source: 'JacRed (Demo)',
        videoCodec: 'H.264',
        audioCodec: 'AAC',
        stabilityScore: 42,
        stabilityLabel: 'Умеренная',
        requiredMbps: 3.0,
      },
      {
        id: 'demo-5',
        title: `${query} ${year || ''} [2160p 4K] [HDR] [HEVC] [DTS-HD 5.1] [Ozz] [NewStudio]`,
        quality: '4K',
        tags: ['HDR'],
        dubbing: 'Прочее',
        size: '31.50 GB',
        sizeBytes: gb(31.5),
        seeders: 12,
        leechers: 8,
        magnet: `magnet:?xt=urn:btih:08da7015a846347d46922970f5b73015db5e9d5&dn=${encodeURIComponent(query)}+HDR`,
        source: 'NNM-Club (Demo)',
        videoCodec: 'HEVC',
        audioCodec: 'DTS',
        stabilityScore: 24,
        stabilityLabel: 'Низкий битрэйт',
        requiredMbps: 21.4,
      },
    ];
  }
}

export const torrServerService = new TorrServerService();
