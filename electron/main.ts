import { app, BrowserWindow, ipcMain, shell, protocol, net, powerMonitor } from 'electron';
import path from 'path';
import { exec } from 'child_process';
import { TorrServerManager, normalizeTorrentLink } from './torrserver.js';
import { TorrentScraper } from './scraper.js';
import { catalogProxy } from './catalog-proxy.js';
import { VkSessionManager } from './vksession.js';
import { JacredManager } from './jacredserver.js';
import { RutrackerSessionManager } from './rutrackerSession.js';

// ═══════════════════════════════════════════════════════════
//  Global error guards — NEVER let the main process die
//  silently (black screen with no window).
// ═══════════════════════════════════════════════════════════
process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught Exception:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled Rejection:', reason);
});

// Chromium media flags MUST be set before app ready — enables HEVC HW decode & audio pipeline
app.commandLine.appendSwitch(
  'enable-features',
  'PlatformHEVCDecoderSupport,AudioServiceOutOfProcess'
);
app.commandLine.appendSwitch('force-wave-audio');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// macOS: enable Metal / VideoToolbox hardware-accelerated decode
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-accelerated-mjpeg-decode');
  app.commandLine.appendSwitch('enable-accelerated-video-decode');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
}

let mainWindow: BrowserWindow | null = null;
const torrServer = new TorrServerManager(8090);
const scraper = new TorrentScraper();
/** Silent VK Auth: гостевая сессия (скрытое окно → cookies) с кэшем и авто-обновлением. */
const vkSession = new VkSessionManager();
/** Локальный JacRed-инстанс (Zero-Config): бинарник + spawn на 127.0.0.1:9117. */
const jacredServer = new JacredManager();
/** Браузерный сеанс RuTracker (Cloudflare bypass + вход в окне приложения). */
const rutrackerSession = new RutrackerSessionManager();
let isQuitting = false;

// ── Single-instance lock ──
// Prevents two copies from fighting over TorrServer port 8090 (double-click,
// updater relaunch, etc.). Second launch focuses the existing window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.warn('[Main] Another Luminary instance is running — quitting.');
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── Register luminary-img:// protocol for image proxying ──
function registerImageProtocol() {
  protocol.handle('luminary-img', async (request) => {
    try {
      // URL format: luminary-img://<base64-encoded-original-url>
      const host = request.url.replace('luminary-img://', '');
      const originalUrl = Buffer.from(host, 'base64').toString('utf-8');

      if (!originalUrl || !/^https?:\/\//i.test(originalUrl)) {
        return new Response('Invalid URL', { status: 400 });
      }

      const img = await catalogProxy.proxyImage(originalUrl);
      if (!img) {
        // Return transparent 1px GIF as fallback
        const onePxGif = new Uint8Array([
          0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00,
          0x01, 0x00, 0x80, 0x00, 0x00, 0xFF, 0xFF, 0xFF,
          0x00, 0x00, 0x00, 0x2C, 0x00, 0x00, 0x00, 0x00,
          0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44,
          0x01, 0x00, 0x3B
        ]);
        return new Response(onePxGif, {
          headers: { 'Content-Type': 'image/gif' },
        });
      }

      return new Response(new Uint8Array(img.data), {
        headers: { 'Content-Type': img.contentType, 'Cache-Control': 'public, max-age=3600' },
      });
    } catch {
      return new Response('Proxy error', { status: 500 });
    }
  });
}

/**
 * Show the window immediately — even before any content is ready —
 * so the user sees a splash instead of a black screen.
 */
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    title: 'Luminary - Torrent Cinema',
    backgroundColor: '#0a0a0d',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });

  // Show as soon as the renderer has painted (prevents white/black flash)
  mainWindow.once('ready-to-show', () => {
    console.log('[Main] Window ready-to-show — displaying');
    mainWindow?.show();
  });

  // Diagnose renderer failures
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Main] did-fail-load (${errorCode}): ${errorDescription} @ ${validatedURL}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[Main] Renderer process gone: ${details.reason} — reloading`);
    // Attempt recovery: reload the window instead of leaving it black
    setTimeout(() => {
      mainWindow?.reload();
    }, 800);
  });

  // Auto-open DevTools in dev mode for immediate visibility of errors
  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  if (isDev) {
    // Dev: load Vite server with retry — the server may not be up yet
    await loadWithRetry(
      () => mainWindow?.loadURL('http://localhost:5173'),
      'http://localhost:5173'
    );
  } else {
    // Prod: load built index.html — base: './' in vite config makes assets resolve correctly
    await mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Load a URL with up to 10 retries (1s apart) — for dev server startup race. */
async function loadWithRetry(loader: () => Promise<void> | undefined, label: string) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await loader();
      console.log(`[Main] Loaded ${label} (attempt ${attempt})`);
      return;
    } catch (err: any) {
      console.warn(`[Main] Load ${label} attempt ${attempt} failed: ${err?.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.error(`[Main] Failed to load ${label} after 10 attempts`);
}

/** Отправить актуальный статус TorrServer в renderer (push-событие). */
function notifyTorrServerStatus(status: { running: boolean; starting?: boolean; port?: number; error?: string }) {
  mainWindow?.webContents.send('torrserver-status-changed', status);
}

/**
 * Start TorrServer WITHOUT blocking window creation.
 * Fire-and-forget: window appears instantly, TorrServer warms up in background.
 * Retries up to MAX_AUTOSTART_ATTEMPTS if the first start fails (binary download
 * or slow metadata) — status is polled by the UI via torrserver:status.
 */
const MAX_AUTOSTART_ATTEMPTS = 3;
const AUTOSTART_RETRY_DELAY_MS = 8000;

function startTorrServerAsync(attempt: number = 1) {
  console.log(`[Main] TorrServer starting in BACKGROUND (non-blocking) — attempt ${attempt}/${MAX_AUTOSTART_ATTEMPTS}...`);
  torrServer
    .startServer()
    .then((status) => {
      if (status.running) {
        console.log('[Main] TorrServer ready on port', status.port);
        // Push актуального состояния в UI — статус 'online'
        notifyTorrServerStatus({ running: true, starting: false, port: status.port });
      } else if (attempt < MAX_AUTOSTART_ATTEMPTS) {
        console.warn(`[Main] TorrServer not ready (${status.error}) — retrying in ${AUTOSTART_RETRY_DELAY_MS / 1000}s...`);
        notifyTorrServerStatus({ running: false, starting: true, port: 8090, error: status.error });
        setTimeout(() => startTorrServerAsync(attempt + 1), AUTOSTART_RETRY_DELAY_MS);
      } else {
        console.warn('[Main] TorrServer failed to start after', MAX_AUTOSTART_ATTEMPTS, 'attempts:', status.error);
        notifyTorrServerStatus({ running: false, starting: false, port: 8090, error: status.error });
      }
    })
    .catch((err: any) => {
      console.warn('[Main] TorrServer background start warning:', err.message);
      notifyTorrServerStatus({ running: false, starting: false, port: 8090, error: err.message });
      if (attempt < MAX_AUTOSTART_ATTEMPTS) {
        setTimeout(() => startTorrServerAsync(attempt + 1), AUTOSTART_RETRY_DELAY_MS);
      }
    });
}

/** Локальный JacRed в фоне: первый запуск качает бинарник (~46 MB) — не блокирует UI. */
function startJacredAsync(attempt: number = 1) {
  console.log(`[Main] JacRed starting in BACKGROUND (non-blocking) — attempt ${attempt}/${MAX_AUTOSTART_ATTEMPTS}...`);
  jacredServer
    .startServer()
    .then((status) => {
      if (status.running) {
        console.log('[Main] Локальный JacRed готов на порту', status.port);
      } else if (attempt < MAX_AUTOSTART_ATTEMPTS) {
        console.warn(`[Main] JacRed not ready (${status.error}) — retrying in ${AUTOSTART_RETRY_DELAY_MS / 1000}s...`);
        setTimeout(() => startJacredAsync(attempt + 1), AUTOSTART_RETRY_DELAY_MS);
      } else {
        console.warn('[Main] JacRed failed to start after', MAX_AUTOSTART_ATTEMPTS, 'attempts:', status.error);
      }
    })
    .catch((err: any) => {
      console.warn('[Main] JacRed background start warning:', err.message);
      if (attempt < MAX_AUTOSTART_ATTEMPTS) {
        setTimeout(() => startJacredAsync(attempt + 1), AUTOSTART_RETRY_DELAY_MS);
      }
    });
}

// ═══════════════════════════════════════════════════════════
//  Keep-Alive Service: heartbeat /echo + авто-восстановление
// ═══════════════════════════════════════════════════════════
const HEARTBEAT_INTERVAL_MS = 7000; // каждые 7 сек — /echo
let heartbeatTimer: NodeJS.Timeout | null = null;
/** Последнее подтверждённое состояние /echo (null — ещё не проверяли). */
let lastHeartbeatAlive: boolean | null = null;

/** Одна проверка heartbeat: /echo + push при смене + keep-alive при падении. */
async function heartbeatTick() {
  const alive = await torrServer.checkHealth();
  // Смена состояния → мгновенный push в Renderer (индикатор без клика)
  if (alive !== lastHeartbeatAlive) {
    lastHeartbeatAlive = alive;
    const lastErr = torrServer.getLastError();
    notifyTorrServerStatus({
      running: alive,
      starting: !alive && torrServer.isStarting(),
      port: 8090,
      error: alive ? undefined : lastErr.error,
    });
  }
  // Keep-Alive: сервер упал / не отвечает → авто-запуск, НО:
  //  - не во время штатного старта (isStarting),
  //  - не после ЯВНОЙ остановки пользователем (isManuallyStopped),
  //  - с лимитами ZONE 2 (MAX_AUTO_RESTARTS=3, cooldown 15с).
  if (!alive && !torrServer.isStarting() && !torrServer.isManuallyStopped()) {
    console.warn('[KeepAlive] Heartbeat: TorrServer не отвечает — авто-восстановление');
    torrServer.keepAliveRestart('heartbeat-timeout');
  }
}

/** Запустить фоновый heartbeat-мониторинг (idempotent). */
function startHeartbeat() {
  if (heartbeatTimer) return;
  console.log(`[Main] Keep-Alive heartbeat started (every ${HEARTBEAT_INTERVAL_MS / 1000}s)`);
  // Первый тик сразу — синхронизируем статус при старте
  heartbeatTick().catch(() => {});
  heartbeatTimer = setInterval(() => {
    heartbeatTick().catch((err) => console.warn('[KeepAlive] heartbeat tick warning:', err.message));
  }, HEARTBEAT_INTERVAL_MS);
}

function setupIPC() {
  // ── Локальный JacRed (Zero-Config) ──
  ipcMain.handle('jacred:status', async () => {
    try {
      const running = await jacredServer.checkHealth();
      // Если креды приватных трекеров появились после старта (введены в веб-UI) —
      // подхватываем их и разгоняем rutracker/nnmclub (throttle 10 мин внутри).
      if (running) jacredServer.syncPrivateCrawls().catch(() => {});
      return {
        running,
        starting: !running && jacredServer.isStarting(),
        port: 9117,
        error: jacredServer.getLastError(),
      };
    } catch (err: any) {
      return { running: false, starting: false, port: 9117, error: err.message };
    }
  });

  ipcMain.handle('jacred:auth', async () => {
    try {
      return await jacredServer.getAuthStatus();
    } catch {
      return { rutracker: false, nnmClub: false };
    }
  });

  ipcMain.handle('jacred:login', async (_e, { tracker, username, password, cookie }) => {
    try {
      const auth = await jacredServer.setTrackerCredentials(tracker, { username, password, cookie });
      return { success: true, auth };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  // ── RuTracker — браузерный сеанс (вход в окне приложения + поиск) ──
  ipcMain.handle('rutracker:status', async () => {
    try {
      return await rutrackerSession.getStatus();
    } catch {
      return { loggedIn: false, loginWindowOpen: false };
    }
  });

  ipcMain.handle('rutracker:open-login', async () => {
    try {
      return await rutrackerSession.openLoginWindow();
    } catch (err: any) {
      return { loggedIn: false, loginWindowOpen: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('rutracker:hide-login', async () => {
    await rutrackerSession.hideLoginWindow();
    return { ok: true };
  });

  ipcMain.handle('rutracker:search', async (_e, { query, year }) => {
    try {
      const releases = await rutrackerSession.search(String(query || ''), year);
      return { success: true, releases };
    } catch (err: any) {
      return { success: false, releases: [], error: err?.message || String(err) };
    }
  });

  ipcMain.handle('jacred:start', async () => {
    const st = await jacredServer.startServer();
    return st;
  });

  ipcMain.handle('jacred:stop', async () => {
    await jacredServer.stopServer();
    return { running: false, port: 9117 };
  });

  ipcMain.handle('jacred:open-ui', async () => {
    await shell.openExternal('http://127.0.0.1:9117/settings');
    return { success: true };
  });

  // ── TorrServer IPC ──
  ipcMain.handle('torrserver:status', async () => {
    try {
      const running = await torrServer.checkHealth();
      const starting = !running && torrServer.isStarting();
      const lastErr = torrServer.getLastError();
      return { running, starting, port: 8090, error: lastErr.error, errorLog: lastErr.errorLog };
    } catch {
      const lastErr = torrServer.getLastError();
      return { running: false, starting: false, port: 8090, error: lastErr.error, errorLog: lastErr.errorLog };
    }
  });

  // ── Логи TorrServer (последние 100 строк из torrserver.log) ──
  ipcMain.handle('torrserver:get-logs', async (_event, lines?: number) => {
    try {
      return { success: true, logs: torrServer.getLogs(typeof lines === 'number' ? lines : 100) };
    } catch (err: any) {
      return { success: false, logs: [], error: err.message };
    }
  });

  ipcMain.handle('torrserver:start', async () => {
    torrServer.setManualStop(false);
    const status = await torrServer.startServer();
    // Push актуального состояния в UI сразу после старта
    notifyTorrServerStatus({
      running: status.running,
      starting: !status.running && torrServer.isStarting(),
      port: 8090,
      error: status.error,
    });
    return status;
  });

  ipcMain.handle('torrserver:stop', async () => {
    // Явная остановка: Keep-Alive НЕ должен сам поднимать сервер после неё
    torrServer.setManualStop(true);
    await torrServer.stopServer();
    // Push остановки в UI
    notifyTorrServerStatus({ running: false, starting: false, port: 8090 });
    return { running: false };
  });

  // Полный рестарт сервера (stop + start) — самолечение зависшего BT-клиента
  ipcMain.handle('torrserver:restart', async () => {
    torrServer.setManualStop(false);
    notifyTorrServerStatus({ running: false, starting: true, port: 8090 });
    await torrServer.stopServer().catch(() => {});
    const status = await torrServer.startServer();
    notifyTorrServerStatus({
      running: status.running,
      starting: !status.running && torrServer.isStarting(),
      port: 8090,
      error: status.error,
    });
    return status;
  });

  ipcMain.handle('torrserver:configure', async (_, ramCacheMB: number) => {
    return await torrServer.configureServer(ramCacheMB);
  });

  ipcMain.handle('torrserver:add', async (_, { magnet, title, poster }) => {
    try {
      // Валидация и нормализация: magnet/http(s)/BTIH-хэш → корректная ссылка
      const norm = normalizeTorrentLink(magnet, title);
      if (!norm.ok) {
        // Некорректная ссылка — не отправляем запрос на TorrServer
        console.warn(`[torrserver:add] BLOCKED link: "${String(magnet).slice(0, 80)}" — ${norm.error}`);
        return { success: false, error: norm.error || 'Некорректная торрент-ссылка' };
      }
      console.log(`[torrserver:add] normalize: "${String(magnet).slice(0, 60)}" → "${(norm.link || '').slice(0, 60)}"`);
      // Защита от undefined-полей в payload
      const payload = {
        action: 'add',
        link: norm.link,
        title: title || 'Movie Stream',
        poster: poster || '',
        save_to_db: true,
      };
      const res = await torrServer.apiRequest('add', payload);
      return { success: true, data: res };
    } catch (err: any) {
      console.error('[IPC torrserver:add error]', err.message);
      // 500 (битый magnet / формат раздачи) → понятная деталь для UI
      const msg = /500|TorrServer API returned/i.test(err.message || '')
        ? 'Ошибка добавления торрента: неверный формат раздачи или битый magnet-link'
        : err.message;
      return { success: false, error: msg };
    }
  });

  ipcMain.handle('torrserver:add-torrent-file', async (_, { base64, title }) => {
    try {
      if (!base64 || typeof base64 !== 'string' || base64.length < 200) {
        return { success: false, error: 'Некорректный .torrent-файл' };
      }
      const res = await torrServer.addTorrentFile(base64, title);
      return { success: true, data: res };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('torrserver:get', async (_, { hash }) => {
    try {
      const res = await torrServer.apiRequest('get', { hash });
      return { success: true, data: res };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('torrserver:remove', async (_, { hash }) => {
    try {
      const res = await torrServer.apiRequest('rem', { hash });
      return { success: true, data: res };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('torrserver:dropCache', async (_, { hash }) => {
    await torrServer.dropTorrentCache(hash);
    return { success: true };
  });

  ipcMain.handle('torrserver:reconnect', async (_, { hash, magnet }) => {
    try {
      await torrServer.reconnectTorrent(hash, magnet || '');
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('torrserver:streamUrl', (_, { hash, fileIndex, transcodeAudio, audioIndex }) => {
    return torrServer.getStreamUrl(hash, fileIndex, !!transcodeAudio, audioIndex);
  });

  // ── Scraper IPC ──
  ipcMain.handle('scraper:search', async (_, { query, year, jackettUrl, jackettApiKey, imdbId, fallbackQuery }) => {
    try {
      const results = await scraper.searchTorrents(
        query,
        year,
        jackettUrl,
        jackettApiKey,
        imdbId,
        fallbackQuery
      );
      return { success: true, releases: results };
    } catch (err: any) {
      return { success: false, releases: [], error: err.message };
    }
  });

  // ── Silent VK Auth: гостевая сессия + поиск видео из main (без CORS) ──
  ipcMain.handle('vk:acquire-session', async () => {
    try {
      const s = await vkSession.getSession();
      return { success: !!s };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('vk:search', async (_e, { query, token }: { query?: string; token?: string }) => {
    try {
      const items = await vkSession.searchVideos(String(query || ''), token || '');
      return { success: true, items: items || [] };
    } catch (err: any) {
      return { success: false, items: [], error: err.message };
    }
  });

  // ── Catalog Proxy IPC (HDRezka / Filmix) ──
  ipcMain.handle('catalog:search', async (_, query: string) => {
    try {
      const results = await catalogProxy.search(query);
      return { success: true, items: results };
    } catch (err: any) {
      return { success: false, items: [], error: err.message };
    }
  });

  ipcMain.handle('catalog:getPage', async (_, { category, page }: { category: string; page: number }) => {
    try {
      const result = await catalogProxy.getCatalog(category, page);
      return { success: true, ...result };
    } catch (err: any) {
      return { success: false, items: [], page: page || 1, hasMore: false, error: err.message };
    }
  });

  ipcMain.handle('catalog:proxyImage', async (_, imageUrl: string) => {
    try {
      const img = await catalogProxy.proxyImage(imageUrl);
      if (!img) return { success: false };
      return {
        success: true,
        data: img.data.toString('base64'),
        contentType: img.contentType,
      };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('catalog:getPlaceholder', (_, title: string) => {
    return catalogProxy.getPlaceholderSVG(title);
  });

  // ── On-Demand streams: прямые плееры HDRezka/Filmix ──
  ipcMain.handle('streams:findPlayers', async (_, args: { title: string; originalTitle: string; year: string }) => {
    try {
      const streams = await catalogProxy.findPlayers(
        args?.title || '',
        args?.originalTitle || '',
        args?.year || ''
      );
      return { success: true, streams };
    } catch (err: any) {
      return { success: false, streams: [], error: err.message };
    }
  });

  // ── Image proxy IPC — bypasses Referer / User-Agent blocks on posters ──
  // Returns a data-URI (base64) so the renderer never hits CORS / hotlink guards.
  ipcMain.handle('fetch-image', async (_event, imageUrl: string) => {
    try {
      if (!imageUrl || typeof imageUrl !== 'string' || !/^https?:\/\//i.test(imageUrl)) {
        return null;
      }
      const response = await net.fetch(imageUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36',
          'Referer': new URL(imageUrl).origin,
        },
      });
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      return `data:${contentType};base64,${base64}`;
    } catch {
      return null;
    }
  });

  // ── Shell / Platform IPC ──
  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      await shell.openExternal(url);
    }
  });

  // ── Open stream in an external player (VLC / IINA) ──
  // Used as fallback when Chromium can't decode MKV / HEVC / AC3.
  ipcMain.handle('player:openExternal', async (_event, url: string) => {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { success: false };
    }
    if (process.platform === 'darwin') {
      // macOS: try VLC → IINA, then fall back to default browser
      for (const appName of ['VLC', 'IINA']) {
        try {
          await new Promise<void>((resolve, reject) => {
            exec(`open -a "${appName}" "${url}"`, (err) => (err ? reject(err) : resolve()));
          });
          return { success: true, app: appName };
        } catch {
          /* try next player */
        }
      }
    }
    await shell.openExternal(url);
    return { success: true, app: 'browser' };
  });

  ipcMain.handle('app:platformInfo', () => {
    return { platform: process.platform, arch: process.arch };
  });
}

app.whenReady().then(async () => {
  console.log('[Main] app.whenReady — initializing');

  try {
    // Register image proxy protocol BEFORE anything else
    registerImageProtocol();
    setupIPC();

    // 1. Create & show the window IMMEDIATELY (non-blocking)
    console.log('[Main] Creating window (immediate)...');
    await createWindow();
    console.log('[Main] Window created');

    // 2. Start TorrServer in background — never blocks the UI
    startTorrServerAsync();
    // 3. Локальный JacRed в фоне (Zero-Config) — первый запуск качает бинарник
    startJacredAsync();
    // 3b. RuTracker-сеанс: скрытое окно проходит Cloudflare-челлендж
    rutrackerSession.ensureSession().catch(() => {});
    rutrackerSession.setLoginListener((loggedIn) => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('rutracker-status-changed', { loggedIn });
      }
    });

    // 3. Keep-Alive: фоновый heartbeat /echo → push статуса + авто-восстановление
    startHeartbeat();

    // 4. macOS resume (выход из сна): немедленно проверить реальный статус /echo
    //    (после сна сеть/процессы могли умереть — UI должен это увидеть сразу)
    powerMonitor.on('resume', () => {
      console.log('[Main] System resumed from sleep — refreshing TorrServer status');
      heartbeatTick().catch((err) => console.warn('[KeepAlive] resume check warning:', err.message));
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  } catch (err: any) {
    console.error('[Main] Fatal init error:', err);
    // Even on fatal error — try to show a window with the error
    try {
      const win = new BrowserWindow({ width: 640, height: 480 });
      win.loadURL(
        `data:text/html,<html><body style="background:#0a0a0d;color:#fff;font-family:sans-serif;padding:2rem"><h2>Ошибка запуска</h2><pre>${encodeURIComponent(String(err))}</pre></body></html>`
      );
    } catch {
      /* nothing else we can do */
    }
  }
});

async function shutdownTorrServer() {
  if (isQuitting) return;
  isQuitting = true;
  console.log('[Main] Application shutting down — tree-kill TorrServer...');
  try {
    await torrServer.stopServer();
  } catch (err: any) {
    console.warn('[Main] stopServer warning:', err.message);
  }
  try {
    await jacredServer.stopServer();
  } catch (err: any) {
    console.warn('[Main] jacred stopServer warning:', err.message);
  }
  rutrackerSession.destroy();
}

app.on('window-all-closed', async () => {
  await shutdownTorrServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async (event) => {
  if (!isQuitting) {
    event.preventDefault();
    await shutdownTorrServer();
    app.quit();
  }
});
