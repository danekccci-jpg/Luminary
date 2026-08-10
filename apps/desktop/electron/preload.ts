import { contextBridge, ipcRenderer } from 'electron';

export interface ElectronAPI {
  getTorrServerStatus: () => Promise<any>;
  startTorrServer: () => Promise<any>;
  stopTorrServer: () => Promise<any>;
  restartTorrServer: () => Promise<any>;
  configureTorrServer: (ramCacheMB: number) => Promise<any>;
  /** Push-подписка на изменения статуса TorrServer из Main Process. Возвращает unsubscribe. */
  onTorrServerStatusChanged: (callback: (status: any) => void) => () => void;
  addMagnetToTorrServer: (magnet: string, title?: string, poster?: string) => Promise<any>;
  addTorrentFileToTorrServer: (base64: string, title?: string) => Promise<any>;
  getTorrServerTorrent: (hash: string) => Promise<any>;
  removeTorrServerTorrent: (hash: string) => Promise<any>;
  dropTorrServerCache: (hash: string) => Promise<any>;
  reconnectTorrServer: (hash: string, magnet: string) => Promise<{ success: boolean; error?: string }>;
  resetTorrServerNetwork: () => Promise<{ success: boolean; error?: string }>;
  onNetworkChanged: (callback: (data: { newIp: string }) => void) => () => void;
  getTorrServerLogs: (lines?: number) => Promise<{ success: boolean; logs: string[]; error?: string }>;
  getStreamUrl: (hash: string, fileIndex?: number, transcodeAudio?: boolean, audioIndex?: number) => Promise<string>;
  searchTorrents: (
    query: string,
    year?: string,
    jackettUrl?: string,
    jackettApiKey?: string,
    imdbId?: string,
    fallbackQuery?: string
  ) => Promise<any>;
  openExternal: (url: string) => Promise<void>;
  getPlatformInfo: () => Promise<{ platform: string; arch: string }>;
  // ── Catalog Proxy (HDRezka / Filmix) ──
  catalogSearch: (query: string) => Promise<{ success: boolean; items: any[]; error?: string }>;
  catalogGetPage: (category: string, page: number) => Promise<{ success: boolean; items: any[]; page: number; hasMore: boolean; error?: string }>;
  catalogProxyImage: (imageUrl: string) => Promise<{ success: boolean; data?: string; contentType?: string }>;
  catalogGetPlaceholder: (title: string) => Promise<string>;
  // Image proxy — returns data-URI or null on failure
  fetchImage: (imageUrl: string) => Promise<string | null>;
  // Прямые онлайн-плееры HDRezka/Filmix
  findPlayers: (
    title: string,
    originalTitle: string,
    year: string
  ) => Promise<{ success: boolean; streams: any[]; error?: string }>;
  // Открыть поток во внешнем плеере (VLC / IINA)
  openInExternalPlayer: (url: string) => Promise<{ success: boolean; app?: string }>;
  // ── Silent VK Auth (main-процесс: гостевая сессия, поиск без CORS) ──
  vkAcquireSession: () => Promise<{ success: boolean; error?: string }>;
  vkSearchVideo: (query: string) => Promise<{
    success: boolean;
    items: Array<{ ownerId: string; videoId: string; hash?: string; title?: string }>;
    error?: string;
  }>;
  // VK Video БЕЗ токена: публичный агрегатор → HLS (electron/vkScraper.ts)
  vkScrapeVideo: (query: string) => Promise<{
    success: boolean;
    items: Array<{
      ownerId: string;
      videoId: string;
      title?: string;
      duration?: number;
      hlsUrl?: string;
      mp4Url?: string;
    }>;
    error?: string;
  }>;
  // ── Локальный JacRed (Zero-Config: бинарник + spawn на 127.0.0.1:9117) ──
  getJacredStatus: () => Promise<{ running: boolean; starting?: boolean; port: number; error?: string }>;
  startJacredServer: () => Promise<{ running: boolean; port: number; error?: string; starting?: boolean }>;
  stopJacredServer: () => Promise<{ running: boolean; port: number }>;
  openJacredUi: () => Promise<{ success: boolean }>;
  /** Авторизация приватных трекеров в локальном JacRed (для плашки в настройках). */
  getJacredAuthStatus: () => Promise<{ rutracker: boolean; nnmClub: boolean }>;
  /** Сохранить креды приватного трекера в конфиг JacRed + разгон парсера. */
  jacredLogin: (
    tracker: 'rutracker' | 'nnmclub',
    creds: { username?: string; password?: string; cookie?: string }
  ) => Promise<{ success: boolean; auth?: { rutracker: boolean; nnmClub: boolean }; error?: string }>;
  // ── RuTracker: браузерный сеанс (Cloudflare bypass, вход в окне приложения) ──
  rutrackerGetStatus: () => Promise<{ loggedIn: boolean; loginWindowOpen: boolean; error?: string }>;
  rutrackerOpenLogin: () => Promise<{ loggedIn: boolean; loginWindowOpen: boolean; error?: string }>;
  rutrackerHideLogin: () => Promise<{ ok: boolean }>;
  rutrackerSearch: (query: string, year?: string, fallbackQuery?: string) => Promise<{ success: boolean; releases: any[]; error?: string }>;
  onRutrackerStatusChanged: (callback: (st: { loggedIn: boolean }) => void) => () => void;
  // ── Онлайн-потоки (KinoBox + Kodik): прямой .m3u8 без TorrServer ──
  searchOnlineStreams: (
    kinopoiskId?: number | string,
    tmdbId?: number | string,
    title?: string,
    year?: string,
    kodikToken?: string
  ) => Promise<{
    success: boolean;
    streams: Array<{
      id: string;
      source: string;
      quality: string;
      translation: string;
      m3u8Url?: string;
      iframeUrl?: string;
      referer?: string;
    }>;
    error?: string;
  }>;
  /** Referer для CDN активного онлайн-потока (сетевой перехватчик Electron). */
  setOnlineStreamReferer: (host: string, referer: string) => Promise<{ ok: boolean }>;
  clearOnlineStreamReferer: (host: string) => Promise<{ ok: boolean }>;
}

contextBridge.exposeInMainWorld('electronAPI', {
  // ── TorrServer ──
  getTorrServerStatus: () => ipcRenderer.invoke('torrserver:status'),
  startTorrServer: () => ipcRenderer.invoke('torrserver:start'),
  stopTorrServer: () => ipcRenderer.invoke('torrserver:stop'),
  restartTorrServer: () => ipcRenderer.invoke('torrserver:restart'),
  onTorrServerStatusChanged: (callback: (status: any) => void) => {
    const listener = (_event: unknown, status: any) => callback(status);
    ipcRenderer.on('torrserver-status-changed', listener);
    return () => ipcRenderer.removeListener('torrserver-status-changed', listener);
  },
  configureTorrServer: (ramCacheMB: number) => ipcRenderer.invoke('torrserver:configure', ramCacheMB),
  addMagnetToTorrServer: (magnet: string, title?: string, poster?: string) =>
    ipcRenderer.invoke('torrserver:add', { magnet, title, poster }),
  addTorrentFileToTorrServer: (base64: string, title?: string) =>
    ipcRenderer.invoke('torrserver:add-torrent-file', { base64, title }),
  getTorrServerTorrent: (hash: string) => ipcRenderer.invoke('torrserver:get', { hash }),
  removeTorrServerTorrent: (hash: string) => ipcRenderer.invoke('torrserver:remove', { hash }),
  dropTorrServerCache: (hash: string) => ipcRenderer.invoke('torrserver:dropCache', { hash }),
  reconnectTorrServer: (hash: string, magnet: string) => ipcRenderer.invoke('torrserver:reconnect', { hash, magnet }),
  resetTorrServerNetwork: () => ipcRenderer.invoke('torrserver:reset-network'),
  onNetworkChanged: (callback: (data: { newIp: string }) => void) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on('network-changed', listener);
    return () => ipcRenderer.removeListener('network-changed', listener);
  },
  getTorrServerLogs: (lines?: number) => ipcRenderer.invoke('torrserver:get-logs', lines),
  getStreamUrl: (hash: string, fileIndex?: number, transcodeAudio?: boolean, audioIndex?: number) =>
    ipcRenderer.invoke('torrserver:streamUrl', { hash, fileIndex, transcodeAudio, audioIndex }),

  // ── Scraper ──
  searchTorrents: (
    query: string,
    year?: string,
    jackettUrl?: string,
    jackettApiKey?: string,
    imdbId?: string,
    fallbackQuery?: string
  ) =>
    ipcRenderer.invoke('scraper:search', { query, year, jackettUrl, jackettApiKey, imdbId, fallbackQuery }),

  // ── Catalog Proxy ──
  catalogSearch: (query: string) => ipcRenderer.invoke('catalog:search', query),
  catalogGetPage: (category: string, page: number) => ipcRenderer.invoke('catalog:getPage', { category, page }),
  catalogProxyImage: (imageUrl: string) => ipcRenderer.invoke('catalog:proxyImage', imageUrl),
  catalogGetPlaceholder: (title: string) => ipcRenderer.invoke('catalog:getPlaceholder', title),
  fetchImage: (imageUrl: string) => ipcRenderer.invoke('fetch-image', imageUrl),
  findPlayers: (title: string, originalTitle: string, year: string) =>
    ipcRenderer.invoke('streams:findPlayers', { title, originalTitle, year }),

  // ── External player ──
  openInExternalPlayer: (url: string) => ipcRenderer.invoke('player:openExternal', url),

  // ── Silent VK Auth ──
  vkAcquireSession: () => ipcRenderer.invoke('vk:acquire-session'),
  vkSearchVideo: (query: string) => ipcRenderer.invoke('vk:search', { query }),
  vkScrapeVideo: (query: string) => ipcRenderer.invoke('vk:scrape', { query }),

  // ── Локальный JacRed (Zero-Config) ──
  getJacredStatus: () => ipcRenderer.invoke('jacred:status'),
  startJacredServer: () => ipcRenderer.invoke('jacred:start'),
  stopJacredServer: () => ipcRenderer.invoke('jacred:stop'),
  openJacredUi: () => ipcRenderer.invoke('jacred:open-ui'),
  getJacredAuthStatus: () => ipcRenderer.invoke('jacred:auth'),
  jacredLogin: (tracker: string, creds: any) => ipcRenderer.invoke('jacred:login', { tracker, ...creds }),
  rutrackerGetStatus: () => ipcRenderer.invoke('rutracker:status'),
  rutrackerOpenLogin: () => ipcRenderer.invoke('rutracker:open-login'),
  rutrackerHideLogin: () => ipcRenderer.invoke('rutracker:hide-login'),
  rutrackerSearch: (query: string, year?: string, fallbackQuery?: string) => ipcRenderer.invoke('rutracker:search', { query, year, fallbackQuery }),
  onRutrackerStatusChanged: (callback: (st: { loggedIn: boolean }) => void) => {
    const listener = (_event: unknown, st: { loggedIn: boolean }) => callback(st);
    ipcRenderer.on('rutracker-status-changed', listener);
    return () => ipcRenderer.removeListener('rutracker-status-changed', listener);
  },

  // ── Онлайн-потоки (KinoBox + Kodik) ──
  searchOnlineStreams: (kinopoiskId?: number | string, tmdbId?: number | string, title?: string, year?: string, kodikToken?: string) =>
    ipcRenderer.invoke('online:get-streams', { kinopoiskId, tmdbId, title, year, kodikToken }),
  setOnlineStreamReferer: (host: string, referer: string) =>
    ipcRenderer.invoke('online:set-referer', { host, referer }),
  clearOnlineStreamReferer: (host: string) =>
    ipcRenderer.invoke('online:clear-referer', host),

  // ── Shell / Platform ──
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  getPlatformInfo: () => ipcRenderer.invoke('app:platformInfo'),
} as ElectronAPI);
