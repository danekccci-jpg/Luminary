import { TorrServerStatusInfo, TorrentRelease, TorrServerStats } from '../types';
import { searchJacRed, mergeReleasesByHash, getJacredStatus } from './scrapers/jacred';
import { getRutrackerStatus } from './rutrackerService';

export class TorrServerService {
  public async getStatus(): Promise<TorrServerStatusInfo> {
    if (window.electronAPI?.getTorrServerStatus) {
      return await window.electronAPI.getTorrServerStatus();
    }
    return { running: true, port: 8090, version: 'Demo Browser Mode' };
  }

  public async startServer(): Promise<TorrServerStatusInfo> {
    if (window.electronAPI?.startTorrServer) {
      return await window.electronAPI.startTorrServer();
    }
    return { running: true, port: 8090 };
  }

  public async stopServer(): Promise<{ running: boolean }> {
    if (window.electronAPI?.stopTorrServer) {
      return await window.electronAPI.stopTorrServer();
    }
    return { running: false };
  }

  /** Полный рестарт сервера — самолечение зависшего BT-клиента. */
  public async restartServer(): Promise<TorrServerStatusInfo> {
    if (window.electronAPI?.restartTorrServer) {
      return await window.electronAPI.restartTorrServer();
    }
    return { running: false, port: 8090 };
  }

  public async configureServer(ramCacheMB: number) {
    if (window.electronAPI?.configureTorrServer) {
      return await window.electronAPI.configureTorrServer(ramCacheMB);
    }
  }

  public async dropCache(hash: string) {
    if (window.electronAPI?.dropTorrServerCache) {
      return await window.electronAPI.dropTorrServerCache(hash);
    }
  }

  /** Переподключение к трекерам/DHT — при пирах>0 и скорости 0.0 MB/s. */
  public async reconnect(hash: string, magnet: string) {
    if (window.electronAPI?.reconnectTorrServer) {
      return await window.electronAPI.reconnectTorrServer(hash, magnet);
    }
    return { success: true };
  }

  /** Логи TorrServer (последние N строк) — для панели отладки в настройках. */
  public async getLogs(lines: number = 100): Promise<string[]> {
    if (window.electronAPI?.getTorrServerLogs) {
      const res = await window.electronAPI.getTorrServerLogs(lines);
      if (res.success) return res.logs;
    }
    return [];
  }

  /** Добавить раздачу из .torrent-файла (base64) — приоритетно для rutracker. */
  public async addTorrentFile(base64: string, title?: string) {
    if (window.electronAPI?.addTorrentFileToTorrServer) {
      return await window.electronAPI.addTorrentFileToTorrServer(base64, title);
    }
    return { success: false, error: 'addTorrentFile IPC недоступен' };
  }

  public async addMagnet(magnet: string, title?: string, poster?: string) {
    if (window.electronAPI?.addMagnetToTorrServer) {
      return await window.electronAPI.addMagnetToTorrServer(magnet, title, poster);
    }
    return { success: true, data: { hash: 'demo-hash-12345' } };
  }

  public async getTorrentStats(hash: string): Promise<{ success: boolean; data?: TorrServerStats; error?: string }> {
    if (window.electronAPI?.getTorrServerTorrent) {
      return await window.electronAPI.getTorrServerTorrent(hash);
    }
    return {
      success: true,
      data: {
        hash,
        title: 'Demo Stream',
        stat: 2,
        stat_string: 'Streaming',
        torrent_size: 4500000000,
        loaded_size: 4500000000,
        download_speed: 6200000,
        upload_speed: 120000,
        active_peers: 24,
        total_peers: 89,
      },
    };
  }

  public async getStreamUrl(
    hash: string,
    fileIndex?: number,
    transcodeAudio?: boolean,
    audioIndex?: number
  ): Promise<string> {
    if (window.electronAPI?.getStreamUrl) {
      return await window.electronAPI.getStreamUrl(hash, fileIndex, transcodeAudio, audioIndex);
    }
    return 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4';
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
    const rutrackerSearch = window.electronAPI?.rutrackerSearch;
    console.log('[TorrServerService] RuTracker late: старт query="' + query + '" (bridge=' + !!rutrackerSearch + ')');
    if (!rutrackerSearch) return { releases: [], applicable: false };
    // Без bb_session поиск пропускаем сразу (Cloudflare-челленджи не гоняем)
    const rtStatus = await getRutrackerStatus().catch(() => null);
    console.log('[TorrServerService] RuTracker late: status=' + (rtStatus?.loggedIn ? 'ok' : 'skip'));
    if (!rtStatus?.loggedIn) return { releases: [], applicable: false };

    // Без жёсткого обрезания race'ом: main сам ограничен дедлайном (45с),
    // а результат МЕДЛЕННОГО (но успешного) прохода НЕ теряется — раньше
    // таймаут 20с выбрасывал найденные раздачи, ретрай молотил Cloudflare
    // заново → «rutracker то есть, то нет» (проверено live).
    const attempt = (): Promise<TorrentRelease[]> =>
      rutrackerSearch(query, year, fallbackQuery)
        .then((res) => (res.success && Array.isArray(res.releases) ? res.releases : []))
        .catch((err: any) => {
          console.warn('[TorrServerService] RuTracker search failed:', err?.message || err);
          return [];
        });

    // Попытка 1: основной проход. Если завершился БЫСТРО и пусто
    // (челлендж-флак первого прохода) — второй проход. Медленный пустой
    // (реально нет раздач) — не дублируем: кэш пустых в main (3 мин)
    // защищает от повторных 40-секундных ожиданий.
    const t0 = Date.now();
    let releases = await attempt();
    if (releases.length === 0 && Date.now() - t0 < 25000) {
      console.log('[TorrServerService] RuTracker: первый проход пуст — повторная попытка');
      releases = await attempt();
    }
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
    // Два независимых источника, запрашиваются ПАРАЛЛЕЛЬНО:
    // 1) Electron-скрапер (Torrentio + Rutor + Jackett при настройке);
    // 2) JacRed API (RuTracker / NNM-Club / Rutor) — отказоустойчивый клиент
    //    с пулом инстансов и авто-фолбэком (src/services/scrapers/jacred.ts).
    // RuTracker (браузерная сессия) — НЕ здесь: см. searchRutrackerLate,
    // он догоняет раздачи фоном, не блокируя выдачу.
    let ipcErrorMsg: string | undefined;
    const ipcPromise: Promise<TorrentRelease[]> = window.electronAPI?.searchTorrents
      ? Promise.race<TorrentRelease[]>([
          window.electronAPI
            .searchTorrents(query, year, jackettUrl, jackettApiKey, imdbId, fallbackQuery)
            .then((res) => {
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

    // Мёрдж: дедуп по BTIH-хэшу magnet + приоритет 4K/2160p → 1080p (по сидам)
    const merged = mergeReleasesByHash(ipcReleases, jacredReleases);
    // Все JacRed-зеркала мертвы — UI покажет плашку «RuTracker временно недоступен»
    const jacredUnreachable = getJacredStatus() === 'unreachable';
    if (merged.length > 0) {
      return { releases: merged, jacredUnreachable };
    }

    // Browser demo mode — нет Electron-моста: показываем демо-раздачи
    if (!window.electronAPI?.searchTorrents) {
      return { releases: this.demoReleases(query, year) };
    }
    return { releases: [], error: ipcErrorMsg || 'Не удалось найти торренты', jacredUnreachable };
  }

  private demoReleases(query: string, year?: string): TorrentRelease[] {
    return [
      {
        id: 'demo-1',
        title: `${query} ${year || ''} [2160p 4K UHD] [Dolby Vision & HDR10+] [REMUX] [HEVC] [Дубляж RHS 5.1]`,
        quality: '4K',
        tags: ['Dolby Vision', 'HDR10+', 'REMUX'],
        dubbing: 'RHS',
        size: '22.4 GB',
        sizeBytes: 22.4 * 1024 * 1024 * 1024,
        seeders: 180,
        leechers: 12,
        magnet: `magnet:?xt=urn:btih:08da7015a846347d46922970f5b73015db5e9da6&dn=${encodeURIComponent(query)}+4K`,
        source: 'JacRed Aggregator (Demo)',
        videoCodec: 'HEVC',
        audioCodec: 'AC3',
        stabilityScore: 92,
        stabilityLabel: 'Отличная',
        requiredMbps: 27.2,
      },
      {
        id: 'demo-2',
        title: `${query} ${year || ''} [1080p FullHD] [WEB-DL] [x264] [Озвучка HDRezka Studio]`,
        quality: '1080p',
        tags: ['WEB-DL'],
        dubbing: 'HDRezka',
        size: '6.8 GB',
        sizeBytes: 6.8 * 1024 * 1024 * 1024,
        seeders: 340,
        leechers: 18,
        magnet: `magnet:?xt=urn:btih:08da7015a846347d46922970f5b73015db5e9da6&dn=${encodeURIComponent(query)}+1080p`,
        source: 'Rutor Tracker (Demo)',
        videoCodec: 'H.264',
        audioCodec: 'AAC',
        stabilityScore: 96,
        stabilityLabel: 'Отличная',
        requiredMbps: 8.2,
      },
      {
        id: 'demo-3',
        title: `${query} ${year || ''} [1080p] [BDRip] [Дубляж Лицензия]`,
        quality: '1080p',
        tags: ['BDRip'],
        dubbing: 'Дубляж',
        size: '4.2 GB',
        sizeBytes: 4.2 * 1024 * 1024 * 1024,
        seeders: 210,
        leechers: 5,
        magnet: `magnet:?xt=urn:btih:08da7015a846347d46922970f5b73015db5e9da6&dn=${encodeURIComponent(query)}+Dub`,
        source: 'Torrentio Network (Demo)',
        videoCodec: 'H.264',
        audioCodec: 'AAC',
        stabilityScore: 88,
        stabilityLabel: 'Отличная',
        requiredMbps: 5.1,
      },
    ];
  }
}

export const torrServerService = new TorrServerService();
