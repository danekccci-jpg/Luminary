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
  /** Сервис в процессе запуска (spawn прошёл, /echo ещё не ответил). */
  starting?: boolean;
  /** Последние строки лога при ошибке старта — для плашки в UI. */
  errorLog?: string;
}

export interface NormalizedLink {
  ok: boolean;
  link?: string;
  error?: string;
}

/**
 * Валидация и нормализация торрент-ссылки перед отправкой в TorrServer.
 * Всеядный режим: принимает magnet-URI (в т.ч. без '?'), http(s)-ссылки на
 * .torrent, голый BTIH-хэш (40 hex SHA-1 / 32 Base32) и хэш с префиксами
 * (urn:btih:, btih:, xt=urn:btih:). Всё, что содержит верный BTIH или
 * HTTP-адрес файла, уходит в TorrServer API — не блокируем сомнительные.
 */
export function normalizeTorrentLink(link: string, title: string): NormalizedLink {
  if (!link || typeof link !== 'string') {
    return { ok: false, error: 'Некорректная торрент-ссылка' };
  }
  const raw = link.trim();
  if (!raw) return { ok: false, error: 'Некорректная торрент-ссылка' };

  const dn = encodeURIComponent(title || 'Movie Stream');

  // 1) HTTP(S): .torrent-файл или страница раздачи — отправляем как есть
  if (/^https?:\/\//i.test(raw)) {
    return { ok: true, link: raw };
  }

  // 2) Magnet (даже без '?', любой регистр)
  if (/^magnet:/i.test(raw)) {
    const btih = extractBtih(raw);
    if (btih) {
      // Пересобираем с гарантированным xt=urn:btih: и сохраняем прочие параметры (dn/tr/...)
      const body = raw.replace(/^magnet:/i, '').replace(/^\?/, '');
      const others = body
        .split('&')
        .filter(Boolean)
        .filter((p) => !/^xt=/i.test(p));
      return {
        ok: true,
        link: `magnet:?xt=urn:btih:${btih}${others.length ? '&' + others.join('&') : ''}`,
      };
    }
    // magnet без распознанного btih — всё равно отправляем (TorrServer сам разберёт)
    return { ok: true, link: raw };
  }

  // 3) BTIH-хэш: голый или с префиксом (urn:btih:, btih:, xt=urn:btih:)
  const btih = extractBtih(raw);
  if (btih) {
    return { ok: true, link: `magnet:?xt=urn:btih:${btih}&dn=${dn}` };
  }

  // 4) Ничего похожего на торрент — блокируем с понятной ошибкой
  return { ok: false, error: 'Некорректная торрент-ссылка' };
}

/**
 * Извлечь BTIH-хэш из произвольной строки: 40 hex (SHA-1) или 32 Base32.
 * Ищет хэш внутри magnet/префиксов — не требует «чистой» строки.
 */
function extractBtih(input: string): string | null {
  const hex = input.match(/\b[a-fA-F0-9]{40}\b/);
  if (hex) return hex[0].toLowerCase();
  const b32 = input.match(/\b[A-Za-z2-7]{32}\b/);
  if (b32) return b32[0].toUpperCase();
  return null;
}

/** Сколько последних строк лога держим в памяти для UI. */
const LOG_BUFFER_MAX = 500;
/** Защита от бесконечных авто-рестартов. */
const MAX_AUTO_RESTARTS = 3;
const RESTART_COOLDOWN_MS = 15000;

export class TorrServerManager {
  private childProcess: ChildProcess | null = null;
  private port: number = 8090;
  private host: string = '127.0.0.1';
  private binaryPath: string = '';
  private dataDir: string = '';
  /** true, если используется gst-сборка MatriX (HLS-транскодинг /gst/master.m3u8). */
  private usingGstBinary: boolean = false;

  // ── Сквозное логирование ──
  private logPath: string = '';
  private logBuffer: string[] = [];

  // ── Автовосстановление по логам ──
  private startingFlag = false;
  /** In-flight start (single-flight: whenReady + heartbeat не гоняют двойной старт). */
  private startPromise: Promise<TorrServerStatus> | null = null;
  private restartCount = 0;
  private lastRestartAt = 0;
  private appliedNetworkFix = false;
  private appliedRamCache = false;
  private lastStartError = '';
  private lastStartErrorLog = '';

  // ── Keep-Alive / heartbeat ──
  /** true, если остановка была ЯВНОЙ (кнопка «Остановить» в настройках).
   *  Keep-Alive НЕ должен сам поднимать сервер после ручной остановки. */
  private manualStopRequested = false;

  constructor(port: number = 8090) {
    this.port = port;
    this.dataDir = path.join(app.getPath('userData'), 'torrserver_data');
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    this.logPath = path.join(app.getPath('userData'), 'torrserver.log');
    this.appendLog('════════ Luminary TorrServer session started ════════');
  }

  /** Флаг «идёт запуск» — для статуса «Запуск сервиса...» в UI. */
  public isStarting(): boolean {
    return this.startingFlag;
  }

  /** Keep-Alive: авто-перезапуск с уважением лимитов ZONE 2
   *  (MAX_AUTO_RESTARTS = 3, cooldown 15 c) — защита от бесконечного цикла. */
  public keepAliveRestart(reason: string): void {
    this.scheduleRestart(reason);
  }

  /** Пометить ЯВНУЮ остановку (кнопка «Остановить») — Keep-Alive не поднимает сервер. */
  public setManualStop(v: boolean): void {
    this.manualStopRequested = v;
  }

  public isManuallyStopped(): boolean {
    return this.manualStopRequested;
  }

  /** Последняя ошибка старта (текст) — для плашки в UI. */
  public getLastError(): { error: string; errorLog: string } {
    return { error: this.lastStartError, errorLog: this.lastStartErrorLog };
  }

  /** Последние N строк лога — для IPC torrserver:get-logs. */
  public getLogs(lines: number = 100): string[] {
    return this.logBuffer.slice(-Math.max(1, Math.min(lines, LOG_BUFFER_MAX)));
  }

  /**
   * Записать строку в torrserver.log (userData) + дублировать в консоль Electron.
   * Параллельно анализирует строку на известные сбои → автовосстановление.
   */
  private appendLog(line: string) {
    const ts = new Date().toISOString();
    const entry = `[${ts}] ${line}`;
    console.log('[TorrServer Log]', line);
    try {
      fs.appendFileSync(this.logPath, entry + '\n');
    } catch {
      /* файл лога недоступен — не критично */
    }
    this.logBuffer.push(entry);
    if (this.logBuffer.length > LOG_BUFFER_MAX) {
      this.logBuffer.splice(0, this.logBuffer.length - LOG_BUFFER_MAX);
    }
    this.analyzeLogLine(line);
  }

  // ── Диагностика сбоев по логам → автовосстановление ──

  /** Найти PID, занимающий порт (macOS/Linux через lsof). */
  private async killProcessOnPort(port: number): Promise<boolean> {
    try {
      const out = execSync(`lsof -ti tcp:${port}`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
        .toString()
        .trim();
      const pids = out.split('\n').map((s) => s.trim()).filter(Boolean);
      for (const pid of pids) {
        // Безопасность: только валидные числовые PID, никогда не убивать себя
        const n = Number(pid);
        if (!Number.isFinite(n) || n <= 1 || n === process.pid) {
          console.warn(`[TorrServer] Skipping unsafe kill target on port ${port} (pid "${pid}")`);
          continue;
        }
        try {
          process.kill(n, 'SIGKILL');
          console.log(`[TorrServer] Killed stale process on port ${port} (pid ${pid})`);
        } catch {
          /* процесс уже умер */
        }
      }
      return pids.length > 0;
    } catch {
      return false; // порт свободен или lsof недоступен
    }
  }

  /**
   * Безопасный запуск CLI-утилиты для очистки процессов.
   * Ошибки `execSync` (отсутствие утилиты, sandbox/permissions, таймаут) НЕ
   * должны ронять главный процесс — в песочницах и ограниченных средах эти
   * команды могут быть запрещены. Возвращает список убитых PID.
   */
  private safeExecKill(cmd: string, label: string): number[] {
    try {
      const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, encoding: 'utf8' });
      const killed: number[] = [];
      for (const raw of (out || '').split('\n')) {
        const n = Number(raw.trim());
        if (!Number.isFinite(n) || n <= 1 || n === process.pid) continue; // никогда не убивать себя
        try {
          process.kill(n, 'SIGKILL');
          killed.push(n);
        } catch {
          /* процесс уже умер */
        }
      }
      if (killed.length) console.log(`[TorrServer] ${label}: killed ${killed.length} process(es) (${killed.join(', ')})`);
      return killed;
    } catch (err: any) {
      // killall/lsof отсутствует или запрещён — безопасно пропускаем (защита от SIGKILL главного процесса)
      console.warn(`[TorrServer] ${label}: skipped (cli unavailable/restricted: ${err?.message || 'unknown'})`);
      return [];
    }
  }

  /** Плановый авто-перезапуск (защита от зацикливания). */
  private scheduleRestart(reason: string) {
    const now = Date.now();
    if (now - this.lastRestartAt < RESTART_COOLDOWN_MS || this.restartCount >= MAX_AUTO_RESTARTS) {
      console.warn(`[TorrServer] Auto-restart skipped (${reason}) — cooldown/limit reached`);
      return;
    }
    this.restartCount++;
    this.lastRestartAt = now;
    console.log(`[TorrServer] Auto-restart due to: ${reason}`);
    this.stopServer()
      .catch(() => {})
      .then(() => {
        setTimeout(() => {
          this.startServer().catch(() => {});
        }, 1500);
      });
  }

  /** P2P-сбой (DHT/UPnP/nat-pmp) → сброс сетевых настроек. */
  private async applyNetworkSettings() {
    if (this.appliedNetworkFix) return;
    this.appliedNetworkFix = true;
    console.log('[TorrServer] P2P issue in logs — resetting network: DHT/UPnP on, PeersListenPort=43211');
    try {
      await this.settingsRequest('set', {
        DisableDHT: false,
        DisableUPNP: false,
        DisablePEX: false,
        DisableUTP: false,
        PeersListenPort: 43211,
      });
    } catch (e: any) {
      console.warn('[TorrServer] Network settings reset warning:', e.message);
    }
  }

  /** Ошибка записи дискового кэша → чистый RAM-кэш (200 MB, без диска). */
  private async applyRamCache() {
    if (this.appliedRamCache) return;
    this.appliedRamCache = true;
    console.log('[TorrServer] Disk cache error in logs — switching to pure RAM cache (200 MB)');
    try {
      await this.settingsRequest('set', {
        CacheSize: 209715200, // ~200 MB
        UseDisk: false,
        TorrentsSavePath: '',
      });
    } catch (e: any) {
      console.warn('[TorrServer] RAM cache switch warning:', e.message);
    }
  }

  /** Анализ строки лога: EACCES / port-in-use / P2P-DHT / дисковый кэш. */
  private analyzeLogLine(line: string) {
    const lower = line.toLowerCase();

    // 1) EACCES / permission denied → chmod 755 бинарника (macOS quarantine)
    if (/eacces|permission denied/.test(lower)) {
      if (this.binaryPath && process.platform !== 'win32') {
        try {
          fs.chmodSync(this.binaryPath, 0o755);
          console.log('[TorrServer] chmod 755 re-applied (EACCES detected)');
        } catch {
          /* ignore */
        }
      }
      // Ошибка записи файлов буфера → RAM-кэш
      if (/file write error|permission denied.*(?:write|create|open|file)/.test(lower)) {
        this.applyRamCache();
      }
    }

    // 2) Порт занят → убить зависший процесс и перезапустить.
    //    На macOS bind может пройти из-за SO_REUSEPORT, но два инстанса
    //    конфликтуют на уровне БД (bboltDB lock) → тоже лечим перезапуском.
    if (/address already in use|bind: address|eaddrnotavail/.test(lower)) {
      this.killProcessOnPort(this.port)
        .then((killed) => {
          if (killed) this.scheduleRestart('port-in-use');
          else this.scheduleRestart('bind-failed');
        })
        .catch(() => this.scheduleRestart('bind-failed'));
      return;
    }
    if (/bboltdb|database is locked|another process/i.test(lower)) {
      this.killProcessOnPort(this.port)
        .then((killed) => {
          if (killed) this.scheduleRestart('db-lock');
          else this.scheduleRestart('db-error');
        })
        .catch(() => this.scheduleRestart('db-error'));
      return;
    }

    // 2.5) BT-клиент не инициализировался / таймаут метаданных → полный
    //    перезапуск сервера. Возникает при старте с сохранённым в settings.json
    //    PeersListenPort или после зависания клиента; рестарт со сбросом
    //    настроек лечит. Cooldown/лимит защищают от лавины перезапусков.
    if (/bt client not connected|timeout connection get torrent info/i.test(lower)) {
      this.scheduleRestart('bt-client-not-ready');
      return;
    }

    // 3) P2P / DHT / UPnP / NAT-PMP сбои → сброс сетевых настроек
    if (/dht.*0 nodes|dht.*no nodes|upnp.*error|nat.?pmp.*fail|upnp.*fail|port mapping.*fail/i.test(lower)) {
      this.applyNetworkSettings();
    }

    // 4) Дисковый кэш → чистый RAM-кэш
    if (/file write error|disk cache|buffer write error/i.test(lower)) {
      this.applyRamCache();
    }
  }

  /**
   * Official YouROK/TorrServer asset names:
   * Windows amd64 → TorrServer-windows-amd64.exe
   */
  /** Имя бинарника TorrServer. `useGst=true` — сборка MatriX.gst (GStreamer):
   *  умеет HLS-транскодинг (/gst/hash/master.m3u8), нужна для HEVC/AC3/DTS/10-bit.
   *  Именование в релизах YouROK/TorrServer: `TorrServer-gst-<plat>-<arch>`.
   *  gst-сборки существуют только для amd64/arm64 (darwin/linux/windows). */
  public getBinaryName(useGst: boolean = false): string {
    const platform = process.platform;
    const arch = process.arch;
    const gstSupported = arch === 'x64' || arch === 'arm64';
    const name = useGst && gstSupported ? 'TorrServer-gst' : 'TorrServer';

    if (platform === 'win32') {
      if (arch === 'ia32') return 'TorrServer-windows-386.exe';
      return `${name}-windows-${arch}.exe`;
    } else if (platform === 'darwin') {
      return `${name}-darwin-${arch}`;
    } else {
      if (arch === 'ia32') return 'TorrServer-linux-386';
      return `${name}-linux-${arch}`;
    }
  }

  /** Binary lives in Electron userData/bin (persistent across updates). */
  public getBinaryDir(): string {
    return path.join(app.getPath('userData'), 'bin');
  }

  /**
   * Bundled binary ships inside the app via extraResources
   * → process.resourcesPath/torrserver/<binary> (never app.asar).
   */
  public getBundledBinaryPath(): string {
    return path.join(process.resourcesPath, 'torrserver', this.getBinaryName());
  }

  /** Re-assert executable permissions (macOS may strip them after updates / quarantine). */
  private ensureExecutable(binPath: string): void {
    if (process.platform === 'win32') return;
    try {
      fs.chmodSync(binPath, 0o755);
    } catch (err: any) {
      console.warn(`[TorrServer] chmod warning for ${binPath}:`, err.message);
    }
  }

  /**
   * Приобрести бинарник TorrServer. Сначала пробуем gst-сборку (MatriX.gst —
   * HLS-транскодинг HEVC/AC3/DTS/10-bit в /gst/master.m3u8), затем обычную.
   * gst-бинарник кладётся в extraResources `resources/torrserver/TorrServer-<plat>-<arch>-gst`
   * и автоматически копируется в Resources/torrserver (см. electron-builder.json5).
   */
  public async getOrDownloadBinary(): Promise<string> {
    const binDir = this.getBinaryDir();
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }

    // 0) ПРЕДПОЧТЕНИЕ: gst-сборка (HLS-транскодинг). На Windows gst-сборки нет —
    //    используем обычную.
    if (process.platform !== 'win32' && (await this.tryAcquireBinary(true))) return this.binaryPath;
    if (await this.tryAcquireBinary(false)) return this.binaryPath;

    throw new Error('Failed to acquire TorrServer binary (gst and standard variants unavailable)');
  }

  /** gst-сборка TorrServer требует системный `gst-discoverer-1.0` (GStreamer):
   *  `/gst/master.m3u8` отвечает «gst-discoverer-1.0 not found» без него. */
  private gstRuntimeAvailable(): boolean {
    try {
      const out = execSync('which gst-discoverer-1.0 || command -v gst-discoverer-1.0 || true', {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
        encoding: 'utf8',
      });
      return (out || '').trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Попытка получить бинарник (bundled extraResources → userData/bin → download). */
  private async tryAcquireBinary(useGst: boolean): Promise<boolean> {
    // Без GStreamer на системе gst-сборка бесполезна (роут /gst/ не отвечает) —
    // выбираем обычный бинарник, чтобы не ломать текущее воспроизведение.
    if (useGst && !this.gstRuntimeAvailable()) {
      console.warn('[TorrServer] gst-discoverer-1.0 (GStreamer) not found — GST transcoder unavailable, using standard binary');
      return false;
    }
    const binaryName = this.getBinaryName(useGst);
    const targetPath = path.join(this.getBinaryDir(), binaryName);

    // 1) Prefer the bundled binary from extraResources (process.resourcesPath),
    //    NOT from inside app.asar (Electron cannot exec files from asar).
    const bundledPath = path.join(process.resourcesPath, 'torrserver', binaryName);
    if (fs.existsSync(bundledPath)) {
      try {
        if (!fs.existsSync(targetPath) || fs.statSync(bundledPath).size !== fs.statSync(targetPath).size) {
          fs.copyFileSync(bundledPath, targetPath);
        }
        this.ensureExecutable(targetPath);
        this.binaryPath = targetPath;
        this.usingGstBinary = useGst;
        console.log(`[TorrServer] Using bundled binary from extraResources: ${bundledPath}${useGst ? ' (GST transcoder)' : ''}`);
        return true;
      } catch (err: any) {
        console.warn('[TorrServer] Failed to use bundled binary, falling back to download:', err.message);
      }
    }

    // 2) Already downloaded in userData/bin
    if (fs.existsSync(targetPath)) {
      this.ensureExecutable(targetPath);
      this.binaryPath = targetPath;
      this.usingGstBinary = useGst;
      console.log(`[TorrServer] Using binary from userData/bin: ${targetPath}${useGst ? ' (GST transcoder)' : ''}`);
      return true;
    }

    // 3) First launch — download from official GitHub Releases
    const downloadUrl = `https://github.com/YouROK/TorrServer/releases/latest/download/${binaryName}`;
    console.log(`[TorrServer] Downloading binary from ${downloadUrl}...`);
    console.log(`[TorrServer] Destination: ${targetPath}`);

    try {
      await this.downloadFile(downloadUrl, targetPath);
      this.ensureExecutable(targetPath);
      this.binaryPath = targetPath;
      this.usingGstBinary = useGst;
      return true;
    } catch (err: any) {
      console.error(`[TorrServer] Download failed for ${binaryName}:`, err.message);
      // Clean partial download
      try {
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      } catch {
        /* ignore */
      }
      return false;
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

  /**
   * Single-flight запуск: whenReady и первый тик heartbeat вызывают startServer
   * почти одновременно; два параллельных потока очисток/lsof гоняли друг друга
   * (второй поток убивал первого через lsof + xargs kill -9 — см. ниже).
   * Теперь параллельный вызов просто дожидается уже идущего старта.
   */
  public startServer(): Promise<TorrServerStatus> {
    if (this.startingFlag && this.startPromise) {
      console.log('[TorrServer] startServer already in progress — reusing in-flight start');
      return this.startPromise;
    }
    this.startingFlag = true;
    this.startPromise = this.startServerImpl();
    return this.startPromise.finally(() => {
      this.startPromise = null;
    });
  }

  private async startServerImpl(): Promise<TorrServerStatus> {
    // Стабильная проверка: сервер считается «уже работающим» только если /echo
    // отвечает 200 несколько раз подряд. Это исключает гонку stop→start,
    // когда умирающий процесс ещё отвечает, но вскоре пропадёт.
    let stableRunning = true;
    for (let i = 0; i < 3; i++) {
      if (!(await this.checkHealth())) { stableRunning = false; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (stableRunning) {
      // /echo уже отвечает 200 — сервер работает (наш или внешний).
      // НЕ запускаем spawn повторно — статус сразу online.
      console.log(`[TorrServer] Already running on http://${this.host}:${this.port} — status online, spawn skipped`);
      this.startingFlag = false;
      await this.configureServer(512);
      return { running: true, port: this.port, version: 'MatriX (Pre-running)' };
    }

    try {
      const binPath = await this.getOrDownloadBinary();

      // ── macOS: снимаем Quarantine-атрибут (Gatekeeper блокирует исполнение) ──
      if (process.platform === 'darwin') {
        try {
          execSync(`xattr -r -d com.apple.quarantine "${binPath}" || true`, { stdio: 'ignore' });
          console.log('[TorrServer] Quarantine attribute cleared (xattr)');
        } catch {
          /* атрибут может отсутствовать — не критично */
        }
      }

      // ── Жёсткая очистка перед стартом: убить зависшие инстансы и bboltDB-локи ──
      // ZONE 1: порядок и назначение НЕ меняются (зомби/локи на 8090).
      // Добавлена безопасность: ошибки CLI-утилит (sandbox/permissions) перехватываются
      // и НЕ роняют главный процесс (раньше execSync мог бросать → SIGKILL-цепочка).
      if (this.childProcess) {
        await this.stopServer().catch(() => {});
      }
      try {
        this.safeExecKill('killall -9 TorrServer || true', 'Killed stale TorrServer processes (killall -9)');
        console.log('[TorrServer] Stale TorrServer processes cleanup finished');
      } catch (err: any) {
        console.warn('[TorrServer] killall cleanup warning (non-fatal):', err?.message);
      }
      try {
        // ⚠️ НЕ `lsof -ti tcp:<port> | xargs kill -9`: lsof выводит и СОБСТВЕННЫЕ
        // клиентские соединения приложения к порту (checkHealth/heartbeat →
        // TIME_WAIT) — xargs убил бы главный процесс (SIGKILL 137, приложение
        // падало на старте). safeExecKill убивает через JS-цикл, исключая
        // process.pid — дохнут только чужие PID (зависшие инстансы на порту).
        this.safeExecKill(`lsof -ti tcp:${this.port} || true`, `Port ${this.port} cleared (lsof kill)`);
        console.log(`[TorrServer] Port ${this.port} cleanup finished`);
      } catch (err: any) {
        console.warn(`[TorrServer] Port ${this.port} cleanup warning (non-fatal):`, err?.message);
      }

      // ── Сброс настроек TorrServer (BT-клиент fix) ──
      // Сохранённый в settings.json PeersListenPort=43211 применяется сервером
      // СРАЗУ при старте и ломает инициализацию BT-клиента
      // («BT client not connected» → 500 на add). Удаляем файл настроек —
      // сервер пересоздаст дефолтный (порт random autoselect 0), а полная
      // конфигурация (включая порт 43211) применяется нами через API
      // после инициализации клиента.
      try {
        const settingsFile = path.join(this.dataDir, 'settings.json');
        if (fs.existsSync(settingsFile)) {
          fs.unlinkSync(settingsFile);
          console.log('[TorrServer] Reset settings.json (stale PeersListenPort cleared)');
        }
      } catch {
        /* файла может не быть — ок */
      }

      // Explicitly re-assert exec permissions right before spawn (macOS/Linux)
      this.ensureExecutable(binPath);
      console.log('[TorrServer] Exec permissions enforced (chmod 755)');

      console.log(`[TorrServer] Spawning process: ${binPath}`);
      this.startingFlag = true;

      // NOTE: только флаги из `TorrServer --help` — текущий релиз НЕ поддерживает
      // `--readahead` (unknown argument → exit code 2). Readahead настраивается
      // через API /settings (ReaderReadAHead). 
      // `--ip 0.0.0.0` — HTTP API + P2P-сокеты на всех интерфейсах (иначе на macOS
      // входящие P2P-подключения/UPNP-проброс не работают → скорость 0.0 MB/s).
      const args = ['--port', this.port.toString(), '--ip', '0.0.0.0', '--path', this.dataDir];
      const argLog = args.join(' ');
      console.log(`[TorrServer] Args: ${argLog}`);
      this.appendLog(`SPAWN ${binPath} ${argLog}`);

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

      // ── Сквозное логирование: весь вывод → torrserver.log + консоль (мгновенно) ──
      this.childProcess.stdout?.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        for (const l of lines) if (l) this.appendLog(l);
      });

      this.childProcess.stderr?.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        for (const l of lines) if (l) this.appendLog(l);
      });

      this.childProcess.on('exit', (code, signal) => {
        console.log(`[TorrServer] Exited with code ${code}, signal ${signal}`);
        this.startingFlag = false;
        this.appendLog(`EXIT code=${code} signal=${signal}`);
        this.childProcess = null;
      });

      this.childProcess.on('error', (err) => {
        console.error('[TorrServer] Spawn error:', err.message);
        this.startingFlag = false;
        this.appendLog(`SPAWN ERROR: ${err.message}`);
        // EACCES при запуске → chmod и повторный запуск
        if (/eacces|permission denied/i.test(err.message)) {
          if (this.binaryPath && process.platform !== 'win32') {
            try { fs.chmodSync(this.binaryPath, 0o755); } catch { /* ignore */ }
          }
          this.scheduleRestart('spawn-eacces');
        }
      });

      // Health-check /echo on 127.0.0.1:<port> — 20 attempts × 500 ms = 10 сек.
      // Status flips to Online only after the server answers 200 OK.
      let ready = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await this.checkHealth()) {
          ready = true;
          break;
        }
      }

      if (ready) {
        this.startingFlag = false;
        this.restartCount = 0;
        this.lastStartError = '';
        this.lastStartErrorLog = '';
        console.log(`[TorrServer] Responsive on port ${this.port} (/echo OK)`);
        this.appendLog('HEALTHCHECK /echo OK — server ready');
        // Сразу: безопасная часть конфига (БЕЗ смены P2P-порта — ранняя смена
        // ломает инициализацию BT-клиента → 500 «BT client not connected»).
        await this.configureServer(512, false);
        // Через 20 сек: фиксированный P2P-порт 43211 + полный конфиг,
        // когда BT-клиент полностью инициализирован.
        setTimeout(() => {
          this.configureServer(512, true).catch(() => {});
        }, 20000);
        return { running: true, port: this.port, binaryPath: binPath };
      }

      // ── Таймаут 10 сек: принудительно убиваем процесс и собираем лог для UI ──
      this.startingFlag = false;
      console.error(`[TorrServer] /echo timeout after 10s — killing process and reading log`);
      if (this.childProcess?.pid) {
        try { this.childProcess.kill('SIGKILL'); } catch { /* ignore */ }
        this.childProcess = null;
      }
      const tail = this.getLogs(8).join('\n');
      this.lastStartError =
        'TorrServer не запустился за 10 секунд. Возможно, бинарник заблокирован Gatekeeper или порт занят.';
      this.lastStartErrorLog = tail;
      return {
        running: false,
        port: this.port,
        error: this.lastStartError,
        errorLog: tail,
      };
    } catch (err: any) {
      this.startingFlag = false;
      console.error('[TorrServer] Start error:', err);
      this.appendLog(`START ERROR: ${err.message}`);
      this.lastStartError = err.message;
      this.lastStartErrorLog = this.getLogs(8).join('\n');
      return { running: false, port: this.port, error: err.message, errorLog: this.lastStartErrorLog };
    }
  }

  /**
   * Configure via POST /settings.
   * ВАЖНО: `PeersListenPort` меняется ТОЛЬКО после полной инициализации BT-клиента
   * (applyPeersPort=true, отложенный вызов). Применение порта в первые секунды
   * после старта ломает клиент → «BT client not connected» / 500 на add.
   */
  public async configureServer(ramCacheMB: number = 300, applyPeersPort: boolean = true): Promise<any> {
    const safeMB = Math.max(64, Math.min(4096, Math.round(ramCacheMB) || 300));
    console.log(`[TorrServer] Configuring: RAM cache ${safeMB} MB, RAM-only mode${applyPeersPort ? ', fixed P2P port 43211' : ' (P2P port deferred)'}`);
    const cacheSizeBytes = safeMB * 1024 * 1024;
    try {
      const current = await this.settingsRequest('get');
      const sets: Record<string, unknown> = {
        ...(current && typeof current === 'object' ? current : {}),
        // ── Критический набор для macOS (P2P-скорость 0.0 MB/s fix) ──
        CacheSize: cacheSizeBytes,          // буфер в RAM
        ReaderReadAHead: 95,                // упреждающее чтение
        PreloadCache: 50,
        PreloadBufferSize: 10485760,        // минимальный предзагрузочный буфер ~10 MB
        UseDisk: false,                     // RAM-only: нет блокировок файловой системы macOS
        TorrentsSavePath: '',
        RemoveCacheOnDrop: false,
        ConnectionsLimit: 120,
        ClientsStatLimit: 30,
        DownloadRateLimit: 0,               // без лимитов скорости
        UploadRateLimit: 0,
        DisableUPNP: false,                 // UPNP/NAT-PMP проброс портов
        DisableDHT: false,                  // DHT-сеть
        DisablePEX: false,                  // Peer Exchange
        DisableUTP: false,                  // uTP (за NAT)
        DisableTCP: false,
        EnableIPv6: false,
        // Настройки НЕ пишем в settings.json: сохранённый PeersListenPort
        // ломает BT-клиент при следующем старте. Конфиг применяется через
        // API при каждом запуске, поэтому файл не нужен.
        StoreSettingsInJson: false,
      };
      if (applyPeersPort) {
        sets.PeersListenPort = 43211;       // фиксированный торрент-порт (после инициализации клиента)
      }
      return await this.settingsRequest('set', sets);
    } catch (e: any) {
      console.warn('[TorrServer] Configure warning:', e.message);
    }
  }

  /**
   * Переподключение торрента к трекерам/DHT — используется, когда
   * пиры есть, но скорость 0.0 MB/s (зависшие DHT-подключения).
   * MatriX.142.2 не поддерживает action "reconnect" (HTTP 400), поэтому
   * пересоздаём торрент: rem + add — трекеры объявляются заново, DHT
   * ищет пиры с нуля. Прогресс буферизации на этом этапе минимален.
   */
  public async reconnectTorrent(hash: string, magnet: string): Promise<void> {
    if (!hash) return;
    console.log(`[TorrServer] Reconnecting torrent ${hash} (rem + add)...`);
    try {
      await this.apiRequest('rem', { hash });
    } catch (e: any) {
      console.warn('[TorrServer] Reconnect rem warning:', e.message);
    }
    try {
      await this.apiRequest('add', {
        link: magnet,
        title: magnet || 'Torrent Stream',
        save_to_db: true,
      });
      console.log(`[TorrServer] Torrent ${hash} re-added — DHT/trackers reconnected`);
    } catch (e: any) {
      console.warn('[TorrServer] Reconnect add warning:', e.message);
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

    // Дождаться ФАКТИЧЕСКОГО освобождения порта (процесс может переживать
    // SIGTERM из-за graceful shutdown). Иначе следующий start увидит умирающий
    // процесс как «already running» и пропустит spawn.
    for (let i = 0; i < 10; i++) {
      if (!(await this.checkHealth())) {
        console.log('[TorrServer] Port released after stop');
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    // Всё ещё отвечает — принудительно SIGKILL по порту
    try {
      execSync(`lsof -ti:${this.port} | xargs kill -9 || true`, { stdio: 'ignore' });
      console.log(`[TorrServer] Port ${this.port} force-cleared (SIGKILL) after stop timeout`);
    } catch {
      /* ignore */
    }
  }

  /**
   * Добавить раздачу из .torrent-файла (base64) — надёжнее магнета: метаданные
   * локально, без обмена метаданными через пиров. Файл пишем в userData/torrents
   * и добавляем по file:// (магнеты в этой сборке часто застревают на метаданных).
   */
  public async addTorrentFile(base64: string, title?: string): Promise<any> {
    const dir = path.join(app.getPath('userData'), 'torrents');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `torrent-${Date.now()}.torrent`);
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    console.log(`[TorrServer] Добавление .torrent-файла (${base64.length} b base64)`);
    return await this.apiRequest('add', {
      link: `file://${filePath}`,
      title: title || 'Movie Stream',
      save_to_db: false,
    });
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
                // 500 и др. — логируем тело ответа в torrserver.log для диагностики
                this.appendLog(`[TorrServer API Error ${res.statusCode}]: ${body.slice(0, 500)}`);
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
   * - audioIndex: 0-based индекс аудиодорожки из MKV-контейнера — для gst HLS
   *   транскодируется именно выбранная дорожка (параметр `audio=N`).
   */
  public getStreamUrl(
    hash: string,
    fileIndex?: number,
    transcodeAudio: boolean = false,
    audioIndex?: number
  ): string {
    const safeHash = encodeURIComponent(hash);
    const idx = fileIndex !== undefined ? fileIndex : 1;

    if (transcodeAudio) {
      // TorrServer MatriX.gst HLS master — audio remuxed to AAC stereo
      return `http://${this.host}:${this.port}/gst/${safeHash}/master.m3u8?index=${idx}&audio=${audioIndex ?? 0}`;
    }

    return `http://${this.host}:${this.port}/stream/fname?link=${safeHash}&index=${idx}&play`;
  }
}
