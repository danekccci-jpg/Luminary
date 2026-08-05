import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { app } from 'electron';
import treeKill from 'tree-kill';

export interface TorrServerStatus {
  running: boolean;
  port: number;
  version?: string;
  error?: string;
  binaryPath?: string;
}

export class TorrServerManager {
  private childProcess: ChildProcess | null = null;
  private port: number = 8090;
  private host: string = '127.0.0.1';
  private binaryPath: string = '';
  private dataDir: string = '';

  constructor(port: number = 8090) {
    this.port = port;
    this.dataDir = path.join(app.getPath('userData'), 'torrserver_data');
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * Official YouROK/TorrServer asset names:
   * Windows amd64 → TorrServer-windows-amd64.exe
   */
  public getBinaryName(): string {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === 'win32') {
      return arch === 'ia32' ? 'TorrServer-windows-386.exe' : 'TorrServer-windows-amd64.exe';
    } else if (platform === 'darwin') {
      return arch === 'arm64' ? 'TorrServer-darwin-arm64' : 'TorrServer-darwin-amd64';
    } else {
      return arch === 'arm64' ? 'TorrServer-linux-arm64' : 'TorrServer-linux-amd64';
    }
  }

  /** Binary lives in Electron userData/bin (persistent across updates). */
  public getBinaryDir(): string {
    return path.join(app.getPath('userData'), 'bin');
  }

  public async getOrDownloadBinary(): Promise<string> {
    const binDir = this.getBinaryDir();
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }

    const binaryName = this.getBinaryName();
    const targetPath = path.join(binDir, binaryName);

    if (fs.existsSync(targetPath)) {
      // Re-assert exec perms on every launch (macOS may strip after updates / quarantine)
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(targetPath, 0o755);
        } catch {
          /* non-fatal */
        }
      }
      this.binaryPath = targetPath;
      return targetPath;
    }

    const downloadUrl = `https://github.com/YouROK/TorrServer/releases/latest/download/${binaryName}`;
    console.log(`[TorrServer] Downloading binary from ${downloadUrl}...`);
    console.log(`[TorrServer] Destination: ${targetPath}`);

    try {
      await this.downloadFile(downloadUrl, targetPath);
      if (process.platform !== 'win32') {
        fs.chmodSync(targetPath, 0o755);
      }
      this.binaryPath = targetPath;
      return targetPath;
    } catch (err: any) {
      console.error('[TorrServer] Download failed:', err.message);
      // Clean partial download
      try {
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      } catch {
        /* ignore */
      }
      throw new Error(`Failed to acquire TorrServer binary: ${err.message}`);
    }
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const request = (targetUrl: string, redirectsLeft = 5) => {
        https
          .get(targetUrl, (response) => {
            if (
              (response.statusCode === 301 ||
                response.statusCode === 302 ||
                response.statusCode === 307 ||
                response.statusCode === 308) &&
              response.headers.location
            ) {
              if (redirectsLeft <= 0) {
                fs.unlink(destPath, () => {});
                reject(new Error('Too many redirects'));
                return;
              }
              request(response.headers.location, redirectsLeft - 1);
              return;
            }
            if (response.statusCode !== 200) {
              fs.unlink(destPath, () => {});
              reject(new Error(`HTTP status code ${response.statusCode}`));
              return;
            }
            response.pipe(file);
            file.on('finish', () => {
              file.close();
              resolve();
            });
          })
          .on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
          });
      };
      request(url);
    });
  }

  public async startServer(): Promise<TorrServerStatus> {
    const isRunning = await this.checkHealth();
    if (isRunning) {
      console.log(`[TorrServer] Already running on http://${this.host}:${this.port}`);
      await this.configureServer(512);
      return { running: true, port: this.port, version: 'MatriX (Pre-running)' };
    }

    try {
      const binPath = await this.getOrDownloadBinary();

      // macOS: force executable permissions (quarantine may strip them)
      if (process.platform === 'darwin') {
        try {
          execSync(`chmod +x "${binPath}"`, { stdio: 'ignore' });
          console.log('[TorrServer] macOS: exec permissions enforced');
        } catch {
          /* non-fatal */
        }
      }

      console.log(`[TorrServer] Spawning process: ${binPath}`);

      // macOS: bind to all interfaces + higher readahead for stable streaming
      const baseArgs = ['-p', this.port.toString(), '-d', this.dataDir];
      if (process.platform === 'darwin') {
        baseArgs.push('--ip', '0.0.0.0', '--readahead', '50');
      }
      const args = baseArgs;

      this.childProcess = spawn(binPath, args, {
        cwd: path.dirname(binPath),
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          // macOS: disable library validation for unsigned binary
          ...(process.platform === 'darwin' ? { DYLD_LIBRARY_PATH: '' } : {}),
        },
      });

      this.childProcess.stdout?.on('data', (data) => {
        console.log(`[TorrServer stdout]: ${data.toString().trim()}`);
      });

      this.childProcess.stderr?.on('data', (data) => {
        console.log(`[TorrServer stderr]: ${data.toString().trim()}`);
      });

      this.childProcess.on('exit', (code, signal) => {
        console.log(`[TorrServer] Exited with code ${code}, signal ${signal}`);
        this.childProcess = null;
      });

      this.childProcess.on('error', (err) => {
        console.error('[TorrServer] Spawn error:', err.message);
      });

      // Health-check /echo on 127.0.0.1:8090 before considering the server ready
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (await this.checkHealth()) {
          console.log(`[TorrServer] Responsive on port ${this.port} (/echo OK)`);
          await this.configureServer(512);
          return { running: true, port: this.port, binaryPath: binPath };
        }
      }

      return {
        running: false,
        port: this.port,
        error: 'TorrServer failed to respond on /echo within timeout',
      };
    } catch (err: any) {
      console.error('[TorrServer] Start error:', err);
      return { running: false, port: this.port, error: err.message };
    }
  }

  /** Configure via POST /settings (not /torrents — that action:set only updates torrent metadata). */
  public async configureServer(ramCacheMB: number = 512): Promise<any> {
    const safeMB = Math.max(64, Math.min(4096, Math.round(ramCacheMB) || 512));
    console.log(`[TorrServer] Configuring RAM Cache size to ${safeMB} MB...`);
    const cacheSizeBytes = safeMB * 1024 * 1024;
    try {
      const current = await this.settingsRequest('get');
      const sets = {
        ...(current && typeof current === 'object' ? current : {}),
        CacheSize: cacheSizeBytes,
        ReaderReadAHead: 95,
        PreloadCache: 50,
        ConnectionsLimit: 120,
      };
      return await this.settingsRequest('set', sets);
    } catch (e: any) {
      console.warn('[TorrServer] Configure warning:', e.message);
    }
  }

  public async dropTorrentCache(hash: string): Promise<void> {
    if (!hash) return;
    console.log(`[TorrServer] Dropping torrent cache for hash: ${hash}`);
    try {
      await this.apiRequest('drop', { hash });
      await this.apiRequest('rem', { hash });
    } catch (e: any) {
      console.warn('[TorrServer] Drop cache warning:', e.message);
    }
  }

  /** Health probe: GET http://127.0.0.1:8090/echo */
  public async checkHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://${this.host}:${this.port}/echo`, { timeout: 1000 }, (res) => {
        // Drain response so the socket can close cleanly
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Guaranteed process-tree cleanup via direct signal + tree-kill (macOS: kill / Windows: taskkill).
   */
  public async stopServer(): Promise<void> {
    if (!this.childProcess?.pid) {
      this.childProcess = null;
      return;
    }

    const pid = this.childProcess.pid;
    console.log(`[TorrServer] Terminating process tree (pid=${pid})...`);

    // Direct SIGTERM first (fast path)
    try {
      if (this.childProcess && !this.childProcess.killed) {
        this.childProcess.kill('SIGTERM');
      }
    } catch {
      /* process may already be gone */
    }

    // tree-kill as safety net for orphaned children
    await new Promise<void>((resolve) => {
      treeKill(pid, 'SIGTERM', (err) => {
        if (err) {
          console.warn('[TorrServer] tree-kill SIGTERM warning:', err.message);
          // Force kill as last resort
          treeKill(pid, 'SIGKILL', () => resolve());
        } else {
          resolve();
        }
      });
    });

    this.childProcess = null;
  }

  public async apiRequest(action: string, payload: any = {}): Promise<any> {
    const postData = JSON.stringify({ action, ...payload });

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: this.host,
          port: this.port,
          path: '/torrents',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: 8000,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve(body ? JSON.parse(body) : {});
              } else {
                reject(new Error(`TorrServer API returned ${res.statusCode}: ${body}`));
              }
            } catch {
              resolve(body);
            }
          });
        }
      );

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('TorrServer /torrents request timed out'));
      });
      req.write(postData);
      req.end();
    });
  }

  private async settingsRequest(action: 'get' | 'set' | 'def', sets?: Record<string, unknown>): Promise<any> {
    const postData = JSON.stringify(sets ? { action, sets } : { action });

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: this.host,
          port: this.port,
          path: '/settings',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: 5000,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve(body ? JSON.parse(body) : {});
              } else {
                reject(new Error(`TorrServer /settings returned ${res.statusCode}: ${body}`));
              }
            } catch {
              resolve(body || {});
            }
          });
        }
      );

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('TorrServer /settings request timed out'));
      });
      req.write(postData);
      req.end();
    });
  }

  /**
   * Build playback URL.
   * - Default: direct /stream (Chromium picks AAC/MP3 track via audioTracks when available).
   * - transcodeAudio: prefer GStreamer HLS (Stereo AAC) when -gst binary is present,
   *   else append m3u hint for clients that remux; still works as progressive fallback.
   */
  public getStreamUrl(hash: string, fileIndex?: number, transcodeAudio: boolean = false): string {
    const safeHash = encodeURIComponent(hash);
    const idx = fileIndex !== undefined ? fileIndex : 1;

    if (transcodeAudio) {
      // TorrServer MatriX.gst HLS master — audio remuxed to AAC stereo
      return `http://${this.host}:${this.port}/gst/${safeHash}/master.m3u8?index=${idx}&audio=0`;
    }

    return `http://${this.host}:${this.port}/stream/fname?link=${safeHash}&index=${idx}&play`;
  }
}
