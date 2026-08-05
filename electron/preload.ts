import { contextBridge, ipcRenderer } from 'electron';

export interface ElectronAPI {
  getTorrServerStatus: () => Promise<any>;
  startTorrServer: () => Promise<any>;
  stopTorrServer: () => Promise<any>;
  configureTorrServer: (ramCacheMB: number) => Promise<any>;
  addMagnetToTorrServer: (magnet: string, title?: string, poster?: string) => Promise<any>;
  getTorrServerTorrent: (hash: string) => Promise<any>;
  removeTorrServerTorrent: (hash: string) => Promise<any>;
  dropTorrServerCache: (hash: string) => Promise<any>;
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
}

contextBridge.exposeInMainWorld('electronAPI', {
  // ── TorrServer ──
  getTorrServerStatus: () => ipcRenderer.invoke('torrserver:status'),
  startTorrServer: () => ipcRenderer.invoke('torrserver:start'),
  stopTorrServer: () => ipcRenderer.invoke('torrserver:stop'),
  configureTorrServer: (ramCacheMB: number) => ipcRenderer.invoke('torrserver:configure', ramCacheMB),
  addMagnetToTorrServer: (magnet: string, title?: string, poster?: string) =>
    ipcRenderer.invoke('torrserver:add', { magnet, title, poster }),
  getTorrServerTorrent: (hash: string) => ipcRenderer.invoke('torrserver:get', { hash }),
  removeTorrServerTorrent: (hash: string) => ipcRenderer.invoke('torrserver:remove', { hash }),
  dropTorrServerCache: (hash: string) => ipcRenderer.invoke('torrserver:dropCache', { hash }),
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

  // ── Shell / Platform ──
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  getPlatformInfo: () => ipcRenderer.invoke('app:platformInfo'),
} as ElectronAPI);
