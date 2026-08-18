/**
 * torrserver-http.ts — HTTP-клиент к TorrServer REST API.
 * Платформо-независимый: работает из Electron (localhost), Capacitor (localhost), браузера.
 */

export interface TorrServerStatus {
  running: boolean;
  port: number;
  version?: string;
}

export interface TorrentInfo {
  hash: string;
  title?: string;
  stat?: number;
  stat_string?: string;
  torrent_size?: number;
  loaded_size?: number;
  preloaded_bytes?: number;
  preload_size?: number;
  download_speed?: number;
  upload_speed?: number;
  active_peers?: number;
  total_peers?: number;
  files?: Array<{ id: number; path: string; length: number }>;
}

const DEFAULT_PORT = 8090;

export class TorrServerHttp {
  private baseUrl: string;

  constructor(port: number = DEFAULT_PORT) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  private async fetch(path: string, opts?: RequestInit): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...opts?.headers },
    });
    if (!res.ok) throw new Error(`TorrServer ${res.status}`);
    return res.json();
  }

  async getStatus(): Promise<TorrServerStatus> {
    try {
      const r = await this.fetch('/settings');
      return { running: true, port: DEFAULT_PORT, version: r.Version || 'TorrServer' };
    } catch {
      return { running: false, port: DEFAULT_PORT };
    }
  }

  async addMagnet(link: string, title?: string, poster?: string): Promise<any> {
    return this.fetch('/torrents', {
      method: 'POST',
      body: JSON.stringify({ Link: link, Title: title, Poster: poster, SaveToDB: true }),
    });
  }

  async addTorrentFile(base64: string, title?: string): Promise<any> {
    return this.fetch('/torrents', {
      method: 'POST',
      body: JSON.stringify({ Torrent: base64, Title: title, SaveToDB: true }),
    });
  }

  async getTorrent(hash: string): Promise<TorrentInfo> {
    const r = await this.fetch('/torrents', {
      method: 'POST',
      body: JSON.stringify({ Hashes: [hash], Action: 0 }),
    });
    return Array.isArray(r) ? r[0] : r;
  }

  async removeTorrent(hash: string): Promise<any> {
    return this.fetch('/torrents', {
      method: 'POST',
      body: JSON.stringify({ Hashes: [hash], Action: 1 }),
    });
  }

  async dropCache(hash: string): Promise<any> {
    return this.fetch('/torrents', {
      method: 'POST',
      body: JSON.stringify({ Hashes: [hash], Action: 2 }),
    });
  }

  async reconnect(hash: string): Promise<any> {
    return this.fetch('/torrents', {
      method: 'POST',
      body: JSON.stringify({ Hashes: [hash], Action: 3 }),
    });
  }

  getStreamUrl(hash: string, fileIndex?: number): string {
    let url = `${this.baseUrl}/stream/${hash}`;
    if (fileIndex != null) url += `?index=${fileIndex}`;
    return url;
  }

  async configure(ramCacheMB: number): Promise<any> {
    return this.fetch('/settings', {
      method: 'POST',
      body: JSON.stringify({ RamCache: ramCacheMB }),
    });
  }

  async probeStream(url: string, timeoutMs = 12000): Promise<{ ok: boolean; status?: number; contentType?: string }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-2097151' },
        signal: controller.signal,
      });
      clearTimeout(timer);
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
}
