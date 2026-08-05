import { TorrServerStatusInfo, TorrentRelease, TorrServerStats } from '../types';

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
    transcodeAudio?: boolean
  ): Promise<string> {
    if (window.electronAPI?.getStreamUrl) {
      return await window.electronAPI.getStreamUrl(hash, fileIndex, transcodeAudio);
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
  ): Promise<{ releases: TorrentRelease[]; error?: string }> {
    if (window.electronAPI?.searchTorrents) {
      try {
        const res = await window.electronAPI.searchTorrents(
          query,
          year,
          jackettUrl,
          jackettApiKey,
          imdbId,
          fallbackQuery
        );
        if (res.success && res.releases) {
          return { releases: res.releases };
        }
        // Surface the real failure instead of silently showing demo data
        return { releases: [], error: res.error || 'Не удалось найти торренты' };
      } catch (err: any) {
        console.error('[TorrServerService] searchTorrents error:', err);
        return { releases: [], error: 'Не удалось выполнить поиск торрентов' };
      }
    }
    // Browser demo mode — no Electron bridge, show demo releases
    return { releases: this.demoReleases(query, year) };
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
