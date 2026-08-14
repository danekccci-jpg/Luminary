/**
 * bridge.ts — Единый адаптер: Electron IPC / Capacitor HTTP / Demo-fallback.
 *
 * Весь фронтенд вызывает bridge.xxx() вместо прямого window.electronAPI.xxx().
 * Определение платформы происходит один раз при загрузке.
 */
import type { TorrServerStatusInfo } from '../types';

// ── Интерфейс (subset наиболее важных методов ElectronAPI) ──
export interface BridgeAPI {
  getTorrServerStatus: () => Promise<TorrServerStatusInfo>;
  startTorrServer: () => Promise<TorrServerStatusInfo>;
  stopTorrServer: () => Promise<{ running: boolean }>;
  restartTorrServer: () => Promise<TorrServerStatusInfo>;
  configureTorrServer: (ramCacheMB: number) => Promise<any>;
  addMagnetToTorrServer: (magnet: string, title?: string, poster?: string) => Promise<any>;
  addTorrentFileToTorrServer: (base64: string, title?: string) => Promise<any>;
  getTorrServerTorrent: (hash: string) => Promise<any>;
  removeTorrServerTorrent: (hash: string) => Promise<any>;
  dropTorrServerCache: (hash: string) => Promise<any>;
  reconnectTorrServer: (hash: string, magnet: string) => Promise<any>;
  getTorrServerLogs: (lines?: number) => Promise<any>;
  getStreamUrl: (hash: string, fileIndex?: number, transcodeAudio?: boolean, audioIndex?: number) => Promise<string>;
  searchTorrents: (query: string, year?: string, jackettUrl?: string, jackettApiKey?: string, imdbId?: string, fallbackQuery?: string) => Promise<any>;
  openExternal: (url: string) => Promise<void>;
  getPlatformInfo: () => Promise<{ platform: string; arch: string }>;
  catalogSearch: (query: string) => Promise<any>;
  catalogGetPage: (category: string, page: number) => Promise<any>;
  catalogProxyImage: (imageUrl: string) => Promise<any>;
  catalogGetPlaceholder: (title: string) => Promise<string>;
  fetchImage: (imageUrl: string) => Promise<string | null>;
  findPlayers: (title: string, originalTitle: string, year: string) => Promise<any>;
  openInExternalPlayer: (url: string) => Promise<any>;
  vkAcquireSession: () => Promise<any>;
  vkSearchVideo: (query: string) => Promise<any>;
  vkScrapeVideo: (query: string) => Promise<any>;
  getJacredStatus: () => Promise<any>;
  startJacredServer: () => Promise<any>;
  stopJacredServer: () => Promise<any>;
  openJacredUi: () => Promise<any>;
  getJacredAuthStatus: () => Promise<any>;
  jacredLogin: (tracker: any, creds: any) => Promise<any>;
  rutrackerGetStatus: () => Promise<any>;
  rutrackerOpenLogin: () => Promise<any>;
  rutrackerHideLogin: () => Promise<any>;
  rutrackerSearch: (query: string, year?: string, fallbackQuery?: string) => Promise<any>;
  onTorrServerStatusChanged: (cb: (st: any) => void) => () => void;
  searchOnlineStreams: (...args: any[]) => Promise<any>;
  setOnlineStreamReferer: (host: string, referer: string) => Promise<any>;
  clearOnlineStreamReferer: (host: string) => Promise<any>;
}

const TS_BASE = 'http://127.0.0.1:8090';

// ── Capacitor HTTP Bridge ──
class CapacitorBridge implements BridgeAPI {
  private plugin: any;

  constructor() {
    try {
      const C = (window as any).Capacitor;
      this.plugin = C?.Plugins?.TorrServer || null;
    } catch { this.plugin = null; }
  }

  private async tsFetch(path: string, opts?: RequestInit): Promise<any> {
    const res = await fetch(`${TS_BASE}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...opts?.headers } });
    return res.json();
  }

  async getTorrServerStatus(): Promise<TorrServerStatusInfo> {
    if (this.plugin) {
      try {
        const r = await this.plugin.isRunning();
        if (r.running) return { running: true, port: 8090, version: 'TorrServer' };
      } catch { /* plugin unavailable */ }
    }
    try {
      const r = await this.tsFetch('/settings');
      return { running: true, port: 8090, version: r.Version || 'TorrServer' };
    } catch { return { running: false, port: 8090 }; }
  }

  async startTorrServer(): Promise<TorrServerStatusInfo> {
    if (this.plugin) {
      try { await this.plugin.start(); }
      catch (e) { console.error('[TorrServer] Plugin start failed:', e); }
      // Poll until ready
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        try { await this.tsFetch('/settings'); return { running: true, port: 8090 }; }
        catch { /* not ready yet */ }
      }
    }
    return this.getTorrServerStatus();
  }

  async stopTorrServer(): Promise<{ running: boolean }> {
    if (this.plugin) { try { await this.plugin.stop(); } catch { /* ignore */ } }
    return { running: false };
  }

  async restartTorrServer(): Promise<TorrServerStatusInfo> {
    await this.stopTorrServer();
    await new Promise(r => setTimeout(r, 1000));
    return this.startTorrServer();
  }
  async configureTorrServer(ramCacheMB: number) {
    return this.tsFetch('/settings', { method: 'POST', body: JSON.stringify({ RamCache: ramCacheMB }) });
  }
  async addMagnetToTorrServer(magnet: string, title?: string, poster?: string) {
    return this.tsFetch('/torrents', { method: 'POST', body: JSON.stringify({ Link: magnet, Title: title, Poster: poster, SaveToDB: true }) });
  }
  async addTorrentFileToTorrServer(base64: string, title?: string) {
    return this.tsFetch('/torrents', { method: 'POST', body: JSON.stringify({ Torrent: base64, Title: title, SaveToDB: true }) });
  }
  async getTorrServerTorrent(hash: string) {
    const r = await this.tsFetch('/torrents', { method: 'POST', body: JSON.stringify({ Hashes: [hash], Action: 0 }) });
    return { success: true, data: r };
  }
  async removeTorrServerTorrent(hash: string) {
    return this.tsFetch('/torrents', { method: 'POST', body: JSON.stringify({ Hashes: [hash], Action: 1 }) });
  }
  async dropTorrServerCache(hash: string) {
    return this.tsFetch('/torrents', { method: 'POST', body: JSON.stringify({ Hashes: [hash], Action: 2 }) });
  }
  async reconnectTorrServer(hash: string, _magnet: string) {
    await this.tsFetch('/torrents', { method: 'POST', body: JSON.stringify({ Hashes: [hash], Action: 3 }) });
    return { success: true };
  }
  async getTorrServerLogs() { return { success: false, logs: [], error: 'Logs not available via HTTP API' }; }
  async getStreamUrl(hash: string, fileIndex?: number) {
    let url = `${TS_BASE}/stream/${hash}`;
    if (fileIndex != null) url += `?index=${fileIndex}`;
    return url;
  }
  async searchTorrents() { return { success: false, releases: [], error: 'Use JacRed pool directly' }; }
  async openExternal(url: string) { window.open(url, '_blank'); }
  async getPlatformInfo() { return { platform: 'android', arch: 'arm64' }; }
  async catalogSearch(q: string) { return { success: true, items: [], error: 'Catalog proxy not available on Android' }; }
  async catalogGetPage() { return { success: true, items: [], page: 0, hasMore: false }; }
  async catalogProxyImage(url: string) { return { success: true, data: url }; }
  async catalogGetPlaceholder(t: string) { return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect fill="#121318" width="200" height="300"/><text x="100" y="150" text-anchor="middle" fill="#888" font-size="14">${t.slice(0,20)}</text></svg>`)}`; }
  async fetchImage(url: string) { return url; }
  async findPlayers() { return { success: true, streams: [] }; }
  async openInExternalPlayer(url: string) { window.open(url, '_blank'); return { success: true }; }
  async vkAcquireSession() { return { success: false, error: 'VK session not available on Android' }; }
  async vkSearchVideo() { return { success: false, items: [] }; }
  async vkScrapeVideo() { return { success: false, items: [], error: 'VK scraping not available on Android' }; }
  async getJacredStatus() { return { running: false }; }
  async startJacredServer() { return { running: false }; }
  async stopJacredServer() { return { running: false }; }
  async openJacredUi() { return { success: false }; }
  async getJacredAuthStatus() { return { rutracker: false, nnmClub: false }; }
  async jacredLogin(tracker: any) { return { success: false, error: 'JacRed login not available on Android' }; }
  async rutrackerGetStatus() { return { loggedIn: false }; }
  async rutrackerOpenLogin() { return { loggedIn: false, loginWindowOpen: false }; }
  async rutrackerHideLogin() { return { ok: true }; }
  async rutrackerSearch() { return { success: false, releases: [] }; }
  onTorrServerStatusChanged() { return () => {}; }
  async searchOnlineStreams() { return { success: true, streams: [] }; }
  async setOnlineStreamReferer() { return { ok: true }; }
  async clearOnlineStreamReferer() { return { ok: true }; }
}

// ── Electron Bridge (пробрасывает window.electronAPI) ──
class ElectronBridge implements BridgeAPI {
  private api = window.electronAPI!;
  getTorrServerStatus = () => this.api.getTorrServerStatus();
  startTorrServer = () => this.api.startTorrServer();
  stopTorrServer = () => this.api.stopTorrServer();
  restartTorrServer = () => this.api.restartTorrServer();
  configureTorrServer = (mb: number) => this.api.configureTorrServer(mb);
  addMagnetToTorrServer = (m: string, t?: string, p?: string) => this.api.addMagnetToTorrServer(m, t, p);
  addTorrentFileToTorrServer = (b: string, t?: string) => this.api.addTorrentFileToTorrServer(b, t);
  getTorrServerTorrent = (h: string) => this.api.getTorrServerTorrent(h);
  removeTorrServerTorrent = (h: string) => this.api.removeTorrServerTorrent(h);
  dropTorrServerCache = (h: string) => this.api.dropTorrServerCache(h);
  reconnectTorrServer = (h: string, m: string) => this.api.reconnectTorrServer(h, m);
  getTorrServerLogs = (l?: number) => this.api.getTorrServerLogs(l);
  getStreamUrl = (h: string, fi?: number, ta?: boolean, ai?: number) => this.api.getStreamUrl(h, fi, ta, ai);
  searchTorrents = (q: string, y?: string, j?: string, k?: string, i?: string, f?: string) => this.api.searchTorrents(q, y, j, k, i, f);
  openExternal = (u: string) => this.api.openExternal(u);
  getPlatformInfo = () => this.api.getPlatformInfo();
  catalogSearch = (q: string) => this.api.catalogSearch(q);
  catalogGetPage = (c: string, p: number) => this.api.catalogGetPage(c, p);
  catalogProxyImage = (u: string) => this.api.catalogProxyImage(u);
  catalogGetPlaceholder = (t: string) => this.api.catalogGetPlaceholder(t);
  fetchImage = (u: string) => this.api.fetchImage(u);
  findPlayers = (t: string, o: string, y: string) => this.api.findPlayers(t, o, y);
  openInExternalPlayer = (u: string) => this.api.openInExternalPlayer(u);
  vkAcquireSession = () => this.api.vkAcquireSession();
  vkSearchVideo = (q: string) => this.api.vkSearchVideo(q);
  vkScrapeVideo = (q: string) => this.api.vkScrapeVideo(q);
  getJacredStatus = () => this.api.getJacredStatus();
  startJacredServer = () => this.api.startJacredServer();
  stopJacredServer = () => this.api.stopJacredServer();
  openJacredUi = () => this.api.openJacredUi();
  getJacredAuthStatus = () => this.api.getJacredAuthStatus();
  jacredLogin = (t: any, c: any) => this.api.jacredLogin(t, c);
  rutrackerGetStatus = () => this.api.rutrackerGetStatus();
  rutrackerOpenLogin = () => this.api.rutrackerOpenLogin();
  rutrackerHideLogin = () => this.api.rutrackerHideLogin();
  rutrackerSearch = (q: string, y?: string, f?: string) => this.api.rutrackerSearch(q, y, f);
  onTorrServerStatusChanged = (cb: (st: any) => void) => this.api.onTorrServerStatusChanged(cb);
  searchOnlineStreams = (...a: any[]) => (this.api as any).searchOnlineStreams(...a);
  setOnlineStreamReferer = (h: string, r: string) => this.api.setOnlineStreamReferer(h, r);
  clearOnlineStreamReferer = (h: string) => this.api.clearOnlineStreamReferer(h);
}

// ── Demo Bridge (fallback для браузера) ──
class DemoBridge implements BridgeAPI {
  async getTorrServerStatus() { return { running: true, port: 8090, version: 'Demo Mode' }; }
  async startTorrServer() { return { running: true, port: 8090 }; }
  async stopTorrServer() { return { running: false }; }
  async restartTorrServer() { return { running: false, port: 8090 }; }
  async configureTorrServer() {}
  async addMagnetToTorrServer() { return { success: true, data: { hash: 'demo-hash' } }; }
  async addTorrentFileToTorrServer() { return { success: false }; }
  async getTorrServerTorrent() { return { success: true, data: {} }; }
  async removeTorrServerTorrent() { return { success: true }; }
  async dropTorrServerCache() { return { success: true }; }
  async reconnectTorrServer() { return { success: true }; }
  async getTorrServerLogs() { return { success: false, logs: [] }; }
  async getStreamUrl() { return 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4'; }
  async searchTorrents() { return { success: false, releases: [] }; }
  async openExternal(u: string) { window.open(u, '_blank'); }
  async getPlatformInfo() { return { platform: 'web', arch: 'x64' }; }
  async catalogSearch() { return { success: true, items: [] }; }
  async catalogGetPage() { return { success: true, items: [], page: 0, hasMore: false }; }
  async catalogProxyImage(u: string) { return { success: true, data: u }; }
  async catalogGetPlaceholder() { return ''; }
  async fetchImage(u: string) { return u; }
  async findPlayers() { return { success: true, streams: [] }; }
  async openInExternalPlayer(u: string) { window.open(u, '_blank'); return { success: true }; }
  async vkAcquireSession() { return { success: false }; }
  async vkSearchVideo() { return { success: false, items: [] }; }
  async vkScrapeVideo() { return { success: false, items: [] }; }
  async getJacredStatus() { return { running: false }; }
  async startJacredServer() { return { running: false }; }
  async stopJacredServer() { return { running: false }; }
  async openJacredUi() { return { success: false }; }
  async getJacredAuthStatus() { return { rutracker: false, nnmClub: false }; }
  async jacredLogin(_t?: any) { return { success: false }; }
  async rutrackerGetStatus() { return { loggedIn: false }; }
  async rutrackerOpenLogin() { return { loggedIn: false }; }
  async rutrackerHideLogin() { return { ok: true }; }
  async rutrackerSearch() { return { success: false, releases: [] }; }
  onTorrServerStatusChanged() { return () => {}; }
  async searchOnlineStreams() { return { success: true, streams: [] }; }
  async setOnlineStreamReferer() { return { ok: true }; }
  async clearOnlineStreamReferer() { return { ok: true }; }
}

// ── Singleton ──
let _bridge: BridgeAPI | null = null;
export function getBridge(): BridgeAPI {
  if (!_bridge) {
    if (window.electronAPI) _bridge = new ElectronBridge();
    else if ((window as any).Capacitor) _bridge = new CapacitorBridge();
    else _bridge = new DemoBridge();
  }
  return _bridge!;
}
