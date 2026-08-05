import { app, BrowserWindow, ipcMain, shell, protocol } from 'electron';
import path from 'path';
import { TorrServerManager } from './torrserver.js';
import { TorrentScraper } from './scraper.js';
import { catalogProxy } from './catalog-proxy.js';

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
let isQuitting = false;

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

/**
 * Start TorrServer WITHOUT blocking window creation.
 * Fire-and-forget: window appears instantly, TorrServer warms up in background.
 */
function startTorrServerAsync() {
  console.log('[Main] TorrServer starting in BACKGROUND (non-blocking)...');
  torrServer
    .startServer()
    .then((status) => {
      if (status.running) {
        console.log('[Main] TorrServer ready on port', status.port);
      } else {
        console.warn('[Main] TorrServer not ready:', status.error);
      }
    })
    .catch((err: any) => {
      console.warn('[Main] TorrServer background start warning:', err.message);
    });
}

function setupIPC() {
  // ── TorrServer IPC ──
  ipcMain.handle('torrserver:status', async () => {
    try {
      const running = await torrServer.checkHealth();
      return { running, port: 8090 };
    } catch {
      return { running: false, port: 8090 };
    }
  });

  ipcMain.handle('torrserver:start', async () => {
    return await torrServer.startServer();
  });

  ipcMain.handle('torrserver:stop', async () => {
    await torrServer.stopServer();
    return { running: false };
  });

  ipcMain.handle('torrserver:configure', async (_, ramCacheMB: number) => {
    return await torrServer.configureServer(ramCacheMB);
  });

  ipcMain.handle('torrserver:add', async (_, { magnet, title, poster }) => {
    try {
      if (!magnet || typeof magnet !== 'string' || !magnet.startsWith('magnet:')) {
        return { success: false, error: 'Invalid magnet link' };
      }
      const res = await torrServer.apiRequest('add', {
        link: magnet,
        title: title || 'Torrent Stream',
        poster: poster || '',
        save_to_db: true,
      });
      return { success: true, data: res };
    } catch (err: any) {
      console.error('[IPC torrserver:add error]', err.message);
      return { success: false, error: err.message };
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

  ipcMain.handle('torrserver:streamUrl', (_, { hash, fileIndex, transcodeAudio }) => {
    return torrServer.getStreamUrl(hash, fileIndex, !!transcodeAudio);
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

  // ── Shell / Platform IPC ──
  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      await shell.openExternal(url);
    }
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
