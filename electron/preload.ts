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
  getTorrServerTorrent: (hash: string) => Promise<any>;
  removeTorrServerTorrent: (hash: string) => Promise<any>;
  dropTorrServerCache: (hash: string) => Promise<any>;
  reconnectTorrServer: (hash: string, magnet: string) => Promise<{ success: boolean; error?: string }>;
  getTorrServerLogs: (lines?: number) => Promise<{ success: boolean; logs: string[]; error?: string }>;
  getStreamUrl: (hash: string, fileIndex?: number, transcodeAudio?: boolean) => Promise<string>;
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
  getTorrServerTorrent: (hash: string) => ipcRenderer.invoke('torrserver:get', { hash }),
  removeTorrServerTorrent: (hash: string) => ipcRenderer.invoke('torrserver:remove', { hash }),
  dropTorrServerCache: (hash: string) => ipcRenderer.invoke('torrserver:dropCache', { hash }),
  reconnectTorrServer: (hash: string, magnet: string) => ipcRenderer.invoke('torrserver:reconnect', { hash, magnet }),
  getTorrServerLogs: (lines?: number) => ipcRenderer.invoke('torrserver:get-logs', lines),
  getStreamUrl: (hash: string, fileIndex?: number, transcodeAudio?: boolean) =>
    ipcRenderer.invoke('torrserver:streamUrl', { hash, fileIndex, transcodeAudio }),

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

  // ── Shell / Platform ──
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  getPlatformInfo: () => ipcRenderer.invoke('app:platformInfo'),
} as ElectronAPI);
