# 🌠 Luminary — Полная сводка для AI-ассистента по разработке

> **Назначение документа:** ввести AI-ассистента (или нового разработчика) в полный контекст
> проекта Luminary перед началом работ. Это аудит-сводка по фактическому коду (на дату 2026-08-09),
> дополняющая `README.md`, `CRITICAL_RULES.md` и `apps/desktop/MACOS_BUILD.md`.
>
> **Обязательно прочитать вместе с `apps/desktop/CRITICAL_RULES.md`** — там зафиксированы «неприкосновенные» зоны кода,
> которые уже неоднократно ломались и чинились.

---

## 1. Что это

**Luminary — кроссплатформенный торрент-кинотеатр для десктопа (Electron).**

- Каталог строится на **TMDB API** (Lampa-style), поиск и подробности фильмов/сериалов — тоже TMDB.
- Воспроизведение — **потоковое через локальный TorrServer MatriX** (Go-бинарник, без полного скачивания), BT-клиент anacrolix.
- Поиск раздач: **JacRed-пул** (RuTracker/NNM/Rutor), **Torrentio**, **Rutor**, **BitSearch**, браузерная **RuTracker-сессия**.
- Онлайн-потоки **без торрентов**: KinoBox + Kodik (прямые `.m3u8`), **VK Video без токена** (агрегатор Яндекс.Видео → HLS).
- Фичи: переключение аудиодорожек MKV, кодек-транскодинг (GStreamer), внешние плееры (VLC/IINA), resume серий, библиотека (Избранное/Позже/История), TV-режим (D-pad).

Язык кода и комментариев — **русский**. UI — русский.

---

## 2. Стек и версии

| Слой | Технология | Версия |
|---|---|---|
| Монорепо | npm workspaces (фактически — обёртки скриптов в корневом `package.json`) | — |
| Desktop | Electron | ^33.2.1 |
| UI | React 18 + TypeScript 5.7 + Vite 6 | — |
| Сборка | electron-builder 25 (dmg/zip, nsis/portable) | — |
| HTTP (main) | axios, cheerio (скрейпинг), Electron `net.fetch` | — |
| Видео (renderer) | hls.js (^1.6.17), нативный `<video>` | — |
| Иконки | lucide-react | ^0.474.0 |
| Прочее | tree-kill, node-polyfills (buffer/stream/util/crypto в renderer) | — |

**Три TypeScript-таргета:**
- `src/` — renderer (Vite, `tsconfig.json`, moduleResolution `bundler`, alias `@/` → `src/`).
- `electron/` — main-процесс (`tsconfig.electron.json`, module `NodeNext`, outDir `dist-electron`, rootDir `electron`).
- Пограничные типы **дублируются** между `src/types/index.ts` и electron-модулями (комментарий: чтобы изолировать сборку от Vite rootDir).

---

## 3. Структура репозитория

```
Luminary/
├── package.json                        # обёртки: desktop:dev / desktop:selftest / desktop:build:mac|win / fetch:torrserver
├── README.md
├── DEVELOPER_CONTEXT.md                # ← этот документ
├── jacred-instances.txt                # динамический список публичных JacRed-зеркал (GitHub raw, TTL 6ч)
├── .github/workflows/release.yml       # CI: tag v* или workflow_dispatch → .dmg/.exe → GitHub Release
└── apps/desktop/
    ├── package.json                    # зависимости, скрипты (dev/build/electron:dev/selftest)
    ├── vite.config.ts                  # react + nodePolyfills, base './', alias @, strictPort 5173
    ├── electron-builder.json5          # appId com.luminary.torrentcinema, asar, extraResources torrserver/
    ├── tsconfig.json / tsconfig.electron.json
    ├── index.html
    ├── CRITICAL_RULES.md               # ⚠️ архитектурный регламент (Зоны 1–8)
    ├── MACOS_BUILD.md                  # инструкция сборки macOS
    ├── build-mac.sh                    # скрипт быстрой сборки macOS
    ├── scripts/
    │   ├── fetch-torrserver.js         # качает бинарники YouROK/TorrServer в resources/torrserver
    │   └── check-torrserver.js
    ├── resources/torrserver/           # бинарники TorrServer (в git НЕ хранятся, .gitignore)
    ├── jacred-instances.txt
    ├── electron/                       # MAIN-процесс (Node + Electron API)
    │   ├── main.ts                     #   окно, IPC, heartbeat, автозапуск сервисов, протоколы
    │   ├── preload.ts                  #   contextBridge electronAPI (весь IPC-контракт)
    │   ├── torrserver.ts               #   TorrServerManager (spawn, watchdog, API-прокси)
    │   ├── jacredserver.ts             #   JacredManager (локальный JacRed на :9117)
    │   ├── scraper.ts                  #   TorrentScraper (Torrentio/Rutor/BitSearch/RuTracker-зеркала/Jackett)
    │   ├── catalog-proxy.ts            #   CatalogProxy (HDRezka + Filmix каталог/плееры/прокси картинок)
    │   ├── rutrackerSession.ts         #   RuTracker через скрытое BrowserWindow (Cloudflare + dl.php → BTIH)
    │   ├── vksession.ts                #   VkSessionManager (гостевая сессия VK, кэш 12ч)
    │   ├── vkScraper.ts                #   VkScraper (Яндекс.Видео → vk video_ext.php → HLS)
    │   ├── onlineBalancers.ts          #   OnlineBalancers (KinoBox + Kodik → .m3u8)
    │   ├── catalog-proxy.ts            #   см. выше
    │   └── tree-kill.d.ts
    ├── src/                            # RENDERER (React)
    │   ├── main.tsx                    # StrictMode + ErrorBoundary + App
    │   ├── App.tsx                     # весь стейт приложения (useState, без Context/Redux)
    │   ├── types/index.ts              # общие типы + Window.electronAPI (IPC-контракт)
    │   ├── components/
    │   │   ├── PlayerModal.tsx         #   ⚠️ плеер (~3050 строк, монолит)
    │   │   ├── MovieDetailsModal.tsx   #   детали фильма/сериала (~1075)
    │   │   ├── SettingsModal.tsx       #   настройки (~850)
    │   │   ├── TorrentSelector.tsx     #   список раздач
    │   │   ├── TorrentCard.tsx         #   карточка раздачи
    │   │   ├── EpisodeResumeDialog.tsx #   диалог продолжения серии
    │   │   ├── Header.tsx / HeroBanner.tsx / MovieGrid.tsx / MovieCard.tsx
    │   │   ├── MagnetInputModal.tsx / Toaster.tsx / ErrorBoundary.tsx
    │   ├── services/
    │   │   ├── torrserver.ts           #   обёртка IPC TorrServer + поиск раздач (merge по BTIH)
    │   │   ├── tmdb.ts                 #   TMDB API (каталог/поиск/детали)
    │   │   ├── catalog.ts              #   HDRezka/Filmix через IPC (НЕ используется в App)
    │   │   ├── library.ts              #   localStorage-библиотека (избранное/позже/история)
    │   │   ├── jacredServer.ts         #   локальный JacRed (порт 9117, syncPoolWithStatus)
    │   │   ├── rutrackerService.ts     #   RuTracker-сессия (статус/логин)
    │   │   ├── vkVideoService.ts       #   VK Video без токена (vk:scrape → vkstream://)
    │   │   ├── onlineBalancers.ts      #   обёртка online:get-streams
    │   │   ├── onlinePlayers.ts        #   ⚠️ НЕ используется (дублирует onlineBalancers)
    │   │   ├── streamTracks.ts         #   EBML/MKV-парсер аудиодорожек (audio=N)
    │   │   ├── cache.ts                #   IndexedDB (luminary_cache v2)
    │   │   ├── toast.ts                #   toast-шина (pub/sub)
    │   │   └── scrapers/jacred.ts      #   JacRed-клиент: пул зеркал, probe, merge, нормализация
    │   ├── utils/
    │   │   ├── torrentMeta.ts          #   parseTorrentMeta (дубляжи/качество/сезоны), russianPriority
    │   │   ├── torrentParser.ts        #   parseTorrentTags (чипы для карточки)
    │   │   ├── tv.ts                   #   TV-режим, back-стек (registerBackHandler/dispatchBack)
    │   │   ├── trackerName.ts          #   sanitizeTrackerName
    │   │   ├── year.ts                 #   extractYear (строго YYYY, 1900..текущий)
    │   │   └── focus.ts                #   фокус/навигация TV
    │   └── styles/index.css            #   тема (CSS-переменные), скетоны, glass, чипы
    └── release/                        # артефакты сборки (в git не хранятся)
```

---

## 4. Архитектура: карта взаимодействия

```
Renderer (React, contextIsolation, НЕТ nodeIntegration)
 ├── PlayerModal.tsx       → IPC: torrserver:add|get|streamUrl|dropCache|reconnect|restart,
 │                           vkstream:// (протокол-прокси), online:set-referer
 ├── App.tsx               → torrserver:status, push torrserver-status-changed, library (localStorage)
 ├── MovieDetailsModal     → scraper:search, rutracker:search, jacred (HTTP из renderer!), vk:scrape,
 │                           online:get-streams, streamTracks (HTTP probe)
 └── SettingsModal         → torrserver:configure/get-logs, jacred:start|stop|open-ui|auth|login,
 │                           rutracker:open-login
        │  IPC (preload.ts contextBridge → ipcRenderer.invoke)
        ▼
Main Process (electron/main.ts)
 ├── TorrServerManager  (torrserver.ts)  → spawn TorrServer на :8090, watchdog по логам, API-прокси
 ├── JacredManager      (jacredserver.ts) → spawn jacred-fdb на :9117 (порт из конфига!)
 ├── RutrackerSessionManager → скрытое BrowserWindow (persist:rutracker) для Cloudflare
 ├── VkScraper / VkSessionManager        → Яндекс.Видео / m.vk.com (гостевая сессия)
 ├── OnlineBalancers                    → KinoBox/Kodik .m3u8
 ├── TorrentScraper                     → Torrentio/Rutor/BitSearch/Jackett/RuTracker-зеркала
 ├── CatalogProxy                       → HDRezka/Filmix + luminary-img:// прокси
 ├── Heartbeat (7с) / powerMonitor / single-instance-lock
 └── Протоколы: vkstream:// (HLS/MP4-прокси), luminary-img:// (прокси картинок)
        │  HTTP (axios / net.fetch)
        ▼
Внешние сервисы:
 ├── TorrServer MatriX (localhost:8090, /echo /torrents /settings /stream, P2P-порт 43211)
 ├── JacRed (localhost:9117) + публичные зеркала (vk.okino.top/jacred и др.)
 ├── TMDB API (каталог/поиск, постеры напрямую image.tmdb.org)
 ├── Torrentio / Cinemeta / Rutor / BitSearch / Jackett (поиск раздач)
 ├── RuTracker.org (браузерная сессия) / rutracker.net|org|nl зеркала
 ├── HDRezka / Filmix (каталог-прокси) / KinoBox / Kodik (онлайн-потоки)
 └── VK (Яндекс.Видео, video_ext.php, vk CDN) / YouTube API (если VK-токен задан → api.vk.com)
```

**Схема потоков данных (поиск раздач):**
`MovieDetailsModal` → параллельно: ① `window.electronAPI.searchTorrents` (main `TorrentScraper`: Torrentio+Rutor+BitSearch+Jackett+RuTracker-зеркала, дедлайн ~5с) и ② `searchJacRed` из renderer (HTTP к пулу зеркал: локальный :9117 → кастомный → динамический пул → дефолтные) → ③ фоновый `searchRutrackerLate` (браузерная сессия, вне дедлайна) → всё мержится **`mergeReleasesByHash`** (BTIH-дедуп, приоритет 4K→1080p→720p→SD → сидеры → RU-бонус → стабильность).

**Схема потоков (просмотр):**
`onPlayTorrent(torrent)` → `App` кладёт `activeStream` (с `nonce: Date.now()`) → `PlayerModal` (remount по `key=nonce`) → `addWithRetry(6, 3000)` магнет/.torrent в TorrServer → ждёт метаданные → `pickVideoIndex` (по расширению и размеру, НЕ index=1) → `getStreamUrl` → **непрерывная предзагрузка** `fetch(/stream, Range 0-262144000)` + чтение тела → `probeStream` (Range 2MB) → монтирует `<video>`/Hls.js → стриминг. Zero-speed детектор на 5-й/15-й секунде → `reconnect` (rem+add).

---

## 5. Ключевые сценарии (пошагово)

### 5.1 Старт приложения (Zero-Config)
1. `app.whenReady` → протоколы (`luminary-img://`, `vkstream://`), `setupIPC()`, referer-перехватчик.
2. Окно показывается сразу (`ready-to-show`), TorrServer и JacRed стартуют **в фоне** (`startTorrServerAsync` / `startJacredAsync`, до 3 попыток, пауза 8с).
3. `rutrackerSession.ensureSession()` — скрытое окно проходит Cloudflare.
4. Heartbeat 7с → `/echo` + push статуса + авто-восстановление (`keepAliveRestart`, лимиты: `MAX_AUTO_RESTARTS=3`, cooldown 15с).
5. Renderer `App.tsx` init: `clearMetaCache()` (IndexedDB) → `applySettingsToServices` → `initZeroConfigSources()` (initLocalJacred с поллингом 30×2с пока качается ~46MB бинарник → refreshRemoteInstancePool + probeJacredPool → vkAcquireSession) → `fetchCatalog()` (6 параллельных TMDB-запросов) → `checkTorrServerStatus()` → подписка на `torrserver-status-changed`.

### 5.2 Торрент-воспроизведение (PlayerModal)
- Статус сервера: если `starting` — пинг `/echo` до 30с.
- `addWithRetry(6, 3000)`: магнет или base64 `.torrent` (для rutracker, надёжнее магнета); при упорном «BT client not connected» → `restartServer()` (IPC) + ожидание 25с + повтор.
- Метаданные до 10с; `pickVideoIndex()` выбирает самый крупный видео-файл по расширению.
- **Предзагрузка обязательна**: пока не читается тело `/stream`, TorrServer не качает (экран 0.0 MB/s при живом рое).
- Два поллера: статистика (1с, `PREBUFFER_BYTES=80MB`) и `ensureStream`/`probeStream` (1.5с, Range `bytes=0-2097151`).
- Кодек-транскодинг: MKV+HEVC/AC3/DTS/TrueHD не играются Chromium → `transcodeAudioToAac` → gst HLS (`/gst/<hash>/master.m3u8?audio=N`) → fallback `/stream` → оверлей VLC/IINA.
- Hls.js с `xhrSetup` (Referer), MEDIA_ERROR → сразу оверлей, NETWORK_ERROR → 3 ретрая → `fallbackToNativeStream()`.
- Выход: `onProgressSave` (resume по эпизодам), `dropCache(hash)`, `dropCache` при close.

### 5.3 Онлайн-потоки (без торрентов)
- VK: `vkScrapeVideo(query)` → main `VkScraper` (Яндекс.Видео → `vk.com/video_ext.php` → hls/mp4 JSON) → renderer фильтрует `<10мин`, лимит 6, кэш 10мин → URL оборачивается в `vkstream://proxy?u=...`.
- Балансеры: `searchOnlineStreams(kpId, tmdbId, title, year, kodikToken)` → main `OnlineBalancers` (KinoBox-эндпоинты + Kodik) → iframe-страницы → regex `.m3u8` → Hls.js. Referer-инжект на уровне сессии для CDN.

### 5.4 RuTracker (два пути)
- **Без кредов** — `RutrackerSessionManager`: скрытое BrowserWindow решает Cloudflare (`cf_clearance`), поиск `tracker.php?nm=`, `.torrent` через `dl.php` в странице, BTIH считается локально (bencode-парсер), магнет собирается из hash. Вход — видимое окно логина (кука `bb_session`).
- **С кредами** — креды пишутся в конфиг локального JacRed (`init.yaml`/`init.conf`) → JacRed парсит RuTracker/NNM глубоко.

---

## 6. IPC-контракт (полная таблица)

Реализация: `electron/preload.ts` (`contextBridge.exposeInMainWorld('electronAPI', …)`), объявление — `src/types/index.ts` (`Window.electronAPI`). Push-события: `torrserver-status-changed`, `rutracker-status-changed`.

| Метод `window.electronAPI.*` | Канал (invoke) | Возвращает | Используется UI |
|---|---|---|---|
| `getTorrServerStatus()` | `torrserver:status` | `{running, starting, port, error, errorLog}` | ✅ |
| `startTorrServer()` | `torrserver:start` | `TorrServerStatusInfo` | ✅ |
| `stopTorrServer()` | `torrserver:stop` | `{running}` | ✅ |
| `restartTorrServer()` | `torrserver:restart` | `TorrServerStatusInfo` | ✅ (самолечение) |
| `configureTorrServer(ramCacheMB)` | `torrserver:configure` | any | ✅ (настройки) |
| `onTorrServerStatusChanged(cb)` | push `torrserver-status-changed` | unsubscribe | ✅ |
| `addMagnetToTorrServer(magnet,title?,poster?)` | `torrserver:add` | `{success, data?, error?}` | ✅ |
| `addTorrentFileToTorrServer(base64,title?)` | `torrserver:add-torrent-file` | `{success, data?, error?}` | ✅ (rutracker) |
| `getTorrServerTorrent(hash)` | `torrserver:get` | `{success, data: TorrServerStats, error?}` | ✅ (статы плеера) |
| `removeTorrServerTorrent(hash)` | `torrserver:remove` | `{success, data?, error?}` | ❌ не используется |
| `dropTorrServerCache(hash)` | `torrserver:dropCache` | `{success}` | ✅ |
| `reconnectTorrServer(hash,magnet)` | `torrserver:reconnect` | `{success, error?}` | ✅ (zero-speed) |
| `getTorrServerLogs(lines?)` | `torrserver:get-logs` | `{success, logs}` | ✅ (настройки) |
| `getStreamUrl(hash,fileIndex?,transcodeAudio?,audioIndex?)` | `torrserver:streamUrl` | string (URL) | ✅ |
| `searchTorrents(query,year?,jackettUrl?,jackettApiKey?,imdbId?,fallbackQuery?)` | `scraper:search` | `{success, releases, error?}` | ✅ |
| `openExternal(url)` | `shell:openExternal` | void | ✅ |
| `getPlatformInfo()` | `app:platformInfo` | `{platform, arch}` | ✅ (TV) |
| `catalogSearch(query)` | `catalog:search` | `{success, items, error?}` | ❌ (заменён TMDB) |
| `catalogGetPage(category,page)` | `catalog:getPage` | `{success, items, page, hasMore, error?}` | ❌ |
| `catalogProxyImage(imageUrl)` | `catalog:proxyImage` | `{success, data?, contentType?}` | ✅ (постеры HDRezka) |
| `catalogGetPlaceholder(title)` | `catalog:getPlaceholder` | string (SVG data-URI) | ✅ |
| `fetchImage(imageUrl)` | `fetch-image` | data-URI \| null | ❌ |
| `findPlayers(title,originalTitle,year)` | `streams:findPlayers` | `{success, streams, error?}` | ❌ |
| `openInExternalPlayer(url)` | `player:openExternal` | `{success, app?}` | ✅ (VLC/IINA) |
| `vkAcquireSession()` | `vk:acquire-session` | `{success, error?}` | ✅ (при старте) |
| `vkSearchVideo(query)` | `vk:search` | `{success, items, error?}` | ❌ **нет handler'а в main** |
| `vkScrapeVideo(query)` | `vk:scrape` | `{success, items, error?}` | ✅ |
| `getJacredStatus()` | `jacred:status` | `{running, starting?, port, error?}` | ✅ |
| `startJacredServer()` | `jacred:start` | статус | ✅ |
| `stopJacredServer()` | `jacred:stop` | `{running, port}` | ✅ |
| `openJacredUi()` | `jacred:open-ui` | `{success}` (shell.openExternal :9117/settings) | ✅ |
| `getJacredAuthStatus()` | `jacred:auth` | `{rutracker, nnmClub}` | ✅ |
| `jacredLogin(tracker, creds)` | `jacred:login` | `{success, auth?, error?}` | ✅ |
| `rutrackerGetStatus()` | `rutracker:status` | `{loggedIn, loginWindowOpen, error?}` | ✅ |
| `rutrackerOpenLogin()` | `rutracker:open-login` | то же | ✅ |
| `rutrackerHideLogin()` | `rutracker:hide-login` | `{ok}` | ✅ |
| `rutrackerSearch(query,year?,fallbackQuery?)` | `rutracker:search` | `{success, releases, error?}` | ✅ (фоновый) |
| `onRutrackerStatusChanged(cb)` | push `rutracker-status-changed` | unsubscribe | ✅ |
| `searchOnlineStreams(kpId?,tmdbId?,title?,year?,kodikToken?)` | `online:get-streams` | `{success, streams, error?}` | ✅ |
| `setOnlineStreamReferer(host,referer)` | `online:set-referer` | `{ok}` | ✅ |
| `clearOnlineStreamReferer(host)` | `online:clear-referer` | `{ok}` | ✅ |

**⚠️ Мёртвые/висячие мосты:** `vkSearchVideo`→`vk:search` (нет handler'а в main.ts), `VkSessionManager.searchVideos` (не вызывается по IPC), `fetchImage`, `findPlayers`, `removeTorrServerTorrent`, `catalogSearch/getPage` — объявлены, но не используются в UI.

---

## 7. Модули main-процесса (детально)

### 7.1 `electron/main.ts` (889 строк)
- Глобальные guard'ы: `uncaughtException`/`unhandledRejection` — main НЕ должен умирать молча (чёрный экран).
- Chromium-флаги ДО ready: `PlatformHEVCDecoderSupport,AudioServiceOutOfProcess`, `force-wave-audio`, `autoplay-policy=no-user-gesture-required`, macOS: ускоренный декод.
- `nativeTheme.themeSource = 'dark'` — тёмный titlebar всегда.
- Протоколы: `vkstream://` (privileged: standard/secure/fetch/stream) и `luminary-img://`.
- Single-instance lock (`requestSingleInstanceLock`).
- Окно 1280×820, `titleBarStyle: hiddenInset` (macOS), `backgroundColor #0A0B0E`, **`webSecurity: false`**, `contextIsolation: true`, preload. DevTools — в dev-режиме. `loadWithRetry` 10×1с для dev-сервера. Recovery: `render-process-gone` → reload.
- Автозапуск TorrServer/JacRed в фоне (3 попытки, 8с), heartbeat 7с, `powerMonitor.on('resume')` → `heartbeatTick()`.
- **Referer-перехватчик** `session.defaultSession.webRequest.onBeforeSendHeaders` — инжектит Referer для CDN онлайн-потоков по hostname.
- `shutdownTorrServer()`: stop TorrServer → stop JacRed → destroy rutrackerSession. Хуки `window-all-closed` (на macOS не выходит из приложения) и `before-quit`.

### 7.2 `electron/torrserver.ts` (1070 строк) — TorrServerManager ⚠️ ZONE 1–2
- Порт **8090**, spawn `--port 8090 --ip 0.0.0.0 --path <dataDir>` (0.0.0.0 обязателен для входящих P2P).
- **Порядок старта (не менять!):** 3×`/echo` стабильная проверка (уже запущен?) → бинарник (bundled → userData/bin → download) → `xattr -r -d com.apple.quarantine` (macOS) → жёсткая очистка (`killall -9 TorrServer`, `lsof` kill) → **удалить `torrserver_data/settings.json`** (иначе «BT client not connected» → 500) → chmod 755 → spawn → healthcheck 20×500мс → `configureServer(512, applyPeersPort=false)` → через 20с `configureServer(512, applyPeersPort=true)` (порт 43211).
- **Watchdog `analyzeLogLine`:** EACCES→chmod; `address already in use|bind|EADDRNOTAVAIL`→kill+restart('port-in-use'); `bboltdb|database is locked`→restart('db-lock'); `bt client not connected|timeout connection get torrent info`→restart('bt-client-not-ready'); `dht.*0 nodes|upnp.*error|nat.?pmp.*fail`→applyNetworkSettings; `file write error|disk cache`→applyRamCache. Лимиты: `MAX_AUTO_RESTARTS=3`, `RESTART_COOLDOWN_MS=15000`.
- `normalizeTorrentLink` — «всеядный»: magnet полный / `urn:btih:` без `magnet:` / без `?` / голый 40-hex / 32-base32 / http(s) `.torrent` / префиксы `btih:`, `xt=urn:btih:`, `urn:btmh:`. **Нельзя ужесточать валидацию** (ZONE 4).
- `getStreamUrl`: `http://127.0.0.1:8090/stream/fname?link=<hash>&index=<idx>&play` или gst: `/gst/<hash>/master.m3u8?index=<idx>&audio=<n>`.
- `addTorrentFile(base64)` → пишет `userData/torrents/torrent-<ts>.torrent` и добавляет через `file://` (метаданные локально — надёжнее магнета).
- `reconnectTorrent` = `rem`+`add` (MatriX.142.2 не имеет `reconnect`), `dropTorrentCache` = `drop`+`rem`.
- `stopServer`: SIGTERM → tree-kill → поллинг 5с → `lsof|kill -9`. Самозащита от SIGKILL-137: фильтр PID (skip `<=1` и `process.pid`).
- Логи: кольцевой буфер 500 строк → `userData/torrserver.log`.
- **Хрупкости:** `--ip 0.0.0.0` открывает API в сеть; `killall -9 TorrServer` убивает чужие инстансы; gst-проверка только по фиксированным путям homebrew; нет retry/checksum при скачивании ~60MB бинарника; `torrents/*.torrent` и tmp-кэш не чистятся.

### 7.3 `electron/jacredserver.ts` (533 строки) — JacredManager
- Порт **9117** (`DEFAULT_PORT`). Бинарник **jacred-fdb** (~46MB), скачивается с GitHub Releases (в extraResources НЕ входит — bundled-ветка мёртвая).
- ⚠️ **jacred-fdb игнорирует `-port` argv** — порт берётся из конфиг-файла `init.yaml`/`init.conf` (в cwd бинарника, hot-reload ~10с); `ensureConfigPort` правит `listenport` regex'ом (не YAML-парсером!). `-path` тоже игнорируется (комментарий).
- Старт: healthcheck `/api/v1.0/conf` (1.5с) → бинарник → конфиг-порт → очистка порта → spawn → 20×500мс.
- Креды приватных трекеров: **в открытом виде в конфиге** (by design — API redact'ит), `readAuthFromFile`/`setTrackerCredentials` (regex-редактирование YAML/JSON), кэш статуса 30с, `syncPrivateCrawls` throttle 10 мин.
- Первичный кравл: `/cron/<tracker>/parse` для публичных (`rutor, bitru, torrentby, kinozal`), приватные — только при кредах.
- **Нет heartbeat/watchdog** (в отличие от TorrServer); recovery пассивный — при каждом `jacred:status` живой `checkHealth()`.
- `extractZip`: `ditto` (darwin) / PowerShell Expand-Archive (win) / `unzip` (linux).
- Хрупкости: regex-редактирование конфига, креды plaintext, нет персистентных логов (только `getLastError()`), `jacred:open-ui` хардкодит `:9117/settings`.

### 7.4 `electron/scraper.ts` (817 строк) — TorrentScraper
- Мультиисточниковый поиск: **Torrentio** (`torrentio.strem.fun/stream/movie/{id}.json`, IMDb через Cinemeta), **Rutor** (`rutor.info`/`rutor.is`, plain HTTP), **BitSearch** (`bitsearch.to`, парсинг по Tailwind-классам — хрупко), **RuTracker-зеркала** (`rutracker.net|org|nl`, tracker.php + RSS), **Jackett** (пользовательский). Плюс `queryJacRed` — **заглушка** (JacRed ушёл в renderer).
- Каждый источник: `withTimeout(5000)`, `Promise.allSettled`, срез 15, дедуп по BTIH (`btih:...`), сорт: RU-бонус (+40 кириллица, +40 студия дубляжа, +20 источник rutracker|rutor|jacred) → сидеры → стабильность.
- Нормализация: `detectQuality/Tags/VideoCodec/AudioCodec/Dubbing`, `stabilityScore` = seedFactor×0.6 + bitrateFactor×0.4 (предполагает 110-мин фильм), `requiredMbps`.
- **Fallback демо-раздачи** с фейковыми магнетами (помечены `(Demo)`) — если все источники мертвы, поиск НИКОГДА не пустой.
- `normalize(...)` — public, переиспользуется `rutrackerSession.ts`.
- Хрупкости: селекторы по CSS-фрагментам (BitSearch/Rutor/RuTracker), парсинг эмодзи в Torrentio (`👤`, `💾`), демо-магнеты проходят в UI, статические списки зеркал.

### 7.5 `electron/catalog-proxy.ts` (780 строк) — CatalogProxy
- HDRezka (5 зеркал: rezka.ag, hdrezka.ag/co/cm, rezka.tv) + Filmix (4 зеркала). Regex-парсинг HTML (без cheerio), `tryMirrors` round-robin с запоминанием рабочего зеркала, кэш 5 мин.
- Функции: `search` (search.php AJAX + `/api/v2/search`), `getCatalog` (Rezka first → Filmix fallback), `findPlayers` (переводчики↔iframe **по индексу** — хрупко), `proxyImage` (для `luminary-img://`), `getPlaceholderSVG`.
- ⚠️ **`rejectUnauthorized: false`** на всех запросах (нет проверки TLS-сертификатов).
- Сейчас используется UI в основном через `catalogProxyImage` (постеры) и `findPlayers` (не используется в UI).

### 7.6 `electron/rutrackerSession.ts` (511 строк) — RutrackerSessionManager
- Скрытое BrowserWindow `persist:rutracker` (1150×850), проходит Cloudflare («Just a moment…» по `document.title`), поиск `tracker.php?nm=`, EXTRACT_ROWS_JS (до 30 строк), загрузка `.torrent` через in-page `fetch('/forum/dl.php?t=…')` → base64 → **`btihFromTorrent`** (локальный bencode-парсер: `4:info` + SHA1) → магнет.
- Вход — видимое окно `login.php` (кука `bb_session`), watcher 4с + push `rutracker-status-changed`.
- Кэш поиска 30 мин (пустой 3 мин, ≤30 ключей), сериализация через promise-chain, дедлайн 60с, до 8 раздач.
- Хрупкости: зависимость от Cloudflare-челленджа, окно с полной сессией без ограничений навигации, предположение о `bb_session`, дедлайн 60с.

### 7.7 `electron/vkScraper.ts` (178 строк) — VkScraper (активный путь VK)
- Яндekc.Видео (`yandex.ru/video/search?text=`) → ссылки `vk.com/video-<owner>_<id>` → `vk.com/video_ext.php?oid=&id=` (Referer `https://vk.com/`) → regex `"hls":"..."`/`"hls_fmp4"`/`"mp4"` → HLS/MP4.
- Таймауты 4с, окно-1251-декадинг, top-8 кандидатов параллельно, фильтр тех-заголовков (subs/audio/track).

### 7.8 `electron/vksession.ts` (167 строк) — VkSessionManager (DORMANT)
- Гостевая сессия: скрытое окно 700×600 → `vk.com` → cookies → `cookieHeader`, TTL 12ч, single-flight. Поиск через `m.vk.com/video?q=` или `api.vk.com` (если token).
- **Не используется** в боевом пути поиска (renderer ходит через `vkScraper`); `vk:acquire-session` вызывается при старте, но результаты сессии не потребляются.

### 7.9 `electron/onlineBalancers.ts` (412 строк) — OnlineBalancers
- KinoBox (`kinobox.tv/api/players`, +`/main`, +зеркало `kinobox.me`) + Kodik (`kodikapi.com/list|search`, token). → список игроков (Collaps/Alloha/Hdvb/Videocdn/Kodik) → fetch iframe → regex `.m3u8` → `pickBestM3u8` (master/index/adaptive).
- `searchOnlineStreams` **никогда не бросает**, деградирует до `[]`. Таймауты 6с, `MAX_RESOLVE=8`, кэш 10 мин.
- ⚠️ **Баговый cacheKey** `kinopoiskId|tmdbId|title|year` — **не включает kodikToken**: если сначала искали без токена (закэширован пустой), потом включили токен — 10 минут Kodik не работает.

---

## 8. Модули renderer (детально)

### 8.1 `src/App.tsx` (733 строки)
- Весь глобальный стейт: `activeTab` (home/movies/top/favorites/later/history), `searchQuery`, 6 массивов каталога, `selectedMovie`, `activeStream`, библиотека, `torrServerStatus`, `jacredStatus`, `settings`, `tvMode`, `ambientColor`.
- Без Context/Redux — чистые useState + props-drilling. Реактивность: `library.onChange`, `toastBus`, back-стек `tv.ts`.
- Дебаунс поиска 350мс (TMDB API), skeleton-загрузка, HeroBanner, ambient-подложка (`extractDominantHue` — canvas).
- `handleSaveSettings` → localStorage `luminary_settings` → `applySettingsToServices` (jacredUrl, tmdbApiKey) → TV-режим → `fetchCatalog()`.
- Просмотр: `activeStream` с `nonce: Date.now()`; `PlayerModal key={nonce}` — каждый запуск = чистый плеер.

### 8.2 `src/components/PlayerModal.tsx` (~3050 строк) — монолит ⚠️
- Два режима: `isOnline = !!directUrl` (VK/балансеры) и торрент (TorrServer).
- Полный цикл торрента описан в §5.2. Ключевые механики — ZONE 3 CRITICAL_RULES (непрерывная предзагрузка, probe 2MB, skip-buffering, addWithRetry(6,3000), pickVideoIndex, zero-speed).
- Hls.js: `enableWorker:true`, `maxBufferLength:60`, `maxMaxBufferLength:120`; `xhrSetup` (Referer vk/directReferer); NETWORK_ERROR→3 ретрая→fallback; MEDIA_ERROR→оверлей VLC/IINA.
- Оверлей ошибки кодека (5с детектор) + `openExternalPlayer()` (VLC→IINA→browser).
- MKV audio switcher (`streamTracks.ts` → `audio=N`), качество HLS (localStorage `luminary_hls_quality`), видеофильтры (brightness/contrast/saturation/grayscale/aspect, `luminary_video_filters`), скорость, субтитры (WebVTT cue), PiP, scrub-preview, end-screen «Следующая серия».
- Resume: `startPosition` seek если `>5 && <duration-10`; `handleClose` → `saveProgress` + `dropCache(hash)`.
- ⚠️ Множество effect-цепочек на `streamUrl`/`streamReady`/`isBuffering` с `eslint-disable exhaustive-deps` — легко сломать тайминги. **Не переписывать целиком, только точечные правки.**

### 8.3 `src/components/MovieDetailsModal.tsx` (~1075 строк)
- Детали фильма/сериала, TMDB-обогащение (`append_to_response=credits,images`), сезон-фильтр, поиск раздач (торренты + VK + онлайн-балансеры), выбор эпизода, resume-диалог (`EpisodeResumeDialog`).
- `playRelease` — собирает payload `activeStream` (season/episode/nextEpisode/onPlayNext/startPosition).

### 8.4 `src/components/TorrentSelector.tsx` + `TorrentCard.tsx`
- Список раздач с сезон-фильтром, sort by `russianPriority`, чипы из `parseTorrentTags` (качество/формат/аудио/дубляж/субтитры), стабильность-кольцо. **Есть незакоммиченный редизайн (см. §17).**

### 8.5 `src/services/torrserver.ts` (renderer-обёртка)
- `TorrServerService`: обёртки всех torrserver IPC. `probeStream(url, 12000)` (Range 2MB). `searchTorrents` с 8с дедлайном: `searchTorrentsImpl` = IPC scraper + `searchJacRed` (renderer HTTP) параллельно, merge через `mergeReleasesByHash`; `searchRutrackerLate` — фоновый, без дедлайна, мёржит реактивно.
- Демо-режим в браузере (`!window.electronAPI`) — фейковые данные.

### 8.6 `src/services/scrapers/jacred.ts` (481 строк)
- Пул: локальный :9117 (первый) → кастомный (`luminary_settings.jacredUrl`) → `localStorage['luminary_jacred_instances']` → динамический remote-пул (GitHub raw, TTL 6ч) → дефолтные (vk.okino.top/jacred, jacred.app, j1/j2, jacred.net).
- `INSTANCE_TIMEOUT_MS=6000`, `OVERALL_DEADLINE_MS=12000`, `FAIL_COOLDOWN_MS=60000` (карантин), `probeJacredPool` (запрос `'test'`).
- Локальный инстанс: Jackett-эндпоинт `/api/v2.0/indexers/all/results?Query=`; публичные: `/api/v1/search?query=&trackers=RuTracker.org,NNM-Club,Rutor`.
- `mergeReleasesByHash(...lists)` — дедуп по BTIH (или title|size), сортировка 4K→1080p→720p→SD → сидеры → RU-бонус → стабильность. Используется везде.

### 8.7 `src/services/tmdb.ts` (276 строк)
- Публичный ключ по умолчанию `8265bd1679663a7ea12ac168da84d2e8` (переопределяется в настройках).
- `getTopRatedMovies`: **`discover/movie?sort_by=vote_average.desc&vote_count.gte=300`** (НЕ `/movie/top_rated?language=ru` — ZONE 8!). Локаль `ru-RU`, без `region`. `fetchPaged` (2 страницы, дедуп, 20..40). Fallback — демо-каталог 21 элемент.
- Постеры напрямую `image.tmdb.org` (CORS разрешён), без IPC-проксирования.

### 8.8 `src/services/library.ts` (167 строк)
- localStorage: `luminary_history` (лимит 50), `luminary_favorites`, `luminary_later`. Ключ истории: `${id}|s${season}e${episode}` — прогресс по эпизодам.
- `saveProgress` — только если `position>0 && duration>0`; `getProgress` — только если `position>5 && <duration-10`.
- `onChange(listener)` pub/sub для реактивного UI.

### 8.9 `src/services/streamTracks.ts` (261 строка)
- EBML/MKV-парсер первых 2MB `/stream` (Range) → `StreamAudioTrack[]` (`index, trackNumber, language, name, codec`). `index` → `audio=N` в gst-URL.

### 8.10 `src/services/cache.ts` — IndexedDB
- `luminary_cache` v2, store `catalog_cache`, записи `{key, data, timestamp, ttl}`, keyPath `key`. `clearMetaCache()` чистит при старте (миграция v1→v2).

### 8.11 `src/utils/torrentMeta.ts` / `torrentParser.ts`
- `parseTorrentMeta(title)`: дубляжи из списка `RU_STUDIOS`, качество, сезоны/эпизоды, кодеки, `isRussian`, `studioScore`. `russianPriority(release)` — RU-first сортировка.
- `parseTorrentTags(title)`: чипы — `{quality, formats, audio, dubbing, subtitles, year, bitrateMbps}` (DV/HEVC/H.264/REMUX/BDRip/WEB-DL/AC3/DTS/...).

### 8.12 `src/utils/tv.ts` / `focus.ts`
- TV-режим: флаг (окно → `luminary_tv_mode` → UA-сниффинг), `registerBackHandler`/`dispatchBack` back-стек, `addBackListener` (Escape всегда, Backspace вне полей, DOM `backbutton`). `focusFirstCard`/`keyActivate`/`useFocusTrap`.

---

## 9. Ключевые типы данных

```ts
// Торрент-раздача (единая форма для всех источников)
interface TorrentRelease {
  id: string;                    // BTIH
  title: string;
  originalTitle?: string;
  quality: '4K' | '1080p' | '720p' | 'SD';
  tags: string[];
  dubbing: DubbingType;          // 'ALL'|'Дубляж'|'RHS'|'HDRezka'|'LostFilm'|'TVShows'|'Кубик в Кубе'|'Оригинал + Субтитры'|'Прочее'
  size: string;  sizeBytes: number;
  seeders: number;  leechers: number;
  magnet: string;
  source: string;                // 'JacRed · Rutor' и т.п.
  videoCodec: 'H.264'|'HEVC'|'AV1'|'Unknown';
  audioCodec: 'AAC'|'AC3'|'EAC3'|'DTS'|'TrueHD'|'Unknown';
  stabilityScore: number;
  stabilityLabel: 'Отличная'|'Хорошая'|'Умеренная'|'Низкий битрэйт';
  requiredMbps: number;
  torrentFile?: string;          // base64 .torrent (только RuTracker-сессия)
}

interface TorrServerStats {       // /torrents get
  hash; title; poster?; stat: number;   // stat===2 → "Streaming"
  stat_string; torrent_size; loaded_size;
  download_speed; upload_speed; active_peers; total_peers;
  file_stats?: { id: number; path: string; length: number }[];
}

interface TorrServerStatusInfo { running; port; version?; error?; starting?; errorLog? }

interface UserSettings {          // localStorage 'luminary_settings'
  tmdbApiKey; torrServerPort; ramCacheMB: 256|512|1024|2048; preBufferMB;
  jackettUrl; jackettApiKey; vkToken; jacredUrl; kodikToken;
  autoStartTorrServer; autoCleanCacheOnClose; transcodeAudioToAac; tvMode?;
}

interface LibraryItem {           // localStorage
  id; title; poster?; year?; mediaType?: 'movie'|'tv';
  position?; duration?; season?; episode?; progressPercentage?; updatedAt;
}

interface Movie {                 // TMDB-центричный
  id: number|string; title; original_title?; name?; overview;
  poster_path; backdrop_path; release_date?; first_air_date?;
  vote_average; vote_count?; genre_ids?; genres?; runtime?;
  media_type?: 'movie'|'tv'; cast?; stills?;
  source?: 'hdrezka'|'filmix'|'tmdb'; url?; quality?;
  season_count?; episode_count?; year?;
}

interface OnlineBalancerStream { id; source; quality; translation; m3u8Url?; iframeUrl?; referer? }
interface CatalogItem { id; source:'hdrezka'|'filmix'; title; original_title; year;
  type:'movie'|'tv'; poster_url; rating; genres[]; description; url; quality?; ... }
```

---

## 10. Персистентность

| Ключ / файл | Что хранит |
|---|---|
| `localStorage['luminary_settings']` | `UserSettings` (включая vkToken/kodikToken/ключи — plaintext!) |
| `localStorage['luminary_history']` | `LibraryItem[]`, лимит 50 |
| `localStorage['luminary_favorites']` / `luminary_later` | избранное / позже |
| `localStorage['luminary_video_filters']` | фильтры видео плеера |
| `localStorage['luminary_hls_quality']` | выбранное качество HLS |
| `localStorage['luminary_tv_mode']` | TV-режим |
| `localStorage['luminary_jacred_instances']` | кастомные JacRed-URL пользователя |
| IndexedDB `luminary_cache` v2 | кэш метаданных (чистится при старте) |
| `userData/torrserver.log` | логи TorrServer (кольцевой буфер 500 строк) |
| `userData/bin/` | бинарники TorrServer/JacRed (копия из bundle или скачанные) |
| `userData/torrserver_data/` | данные TorrServer (settings.json удаляется при каждом старте!) |
| `userData/torrents/torrent-*.torrent` | .torrent файлы (не чистятся) |
| `<jacred bin dir>/init.yaml|init.conf` | конфиг JacRed (порт + креды приватных трекеров plaintext) |
| `os.tmpdir()/luminary_ts` | disk-кэш gst-транскодера |

---

## 11. Ключевые константы

| Константа | Значение | Где |
|---|---|---|
| TorrServer порт | 8090 | torrserver.ts / main.ts |
| JacRed порт | 9117 | jacredserver.ts / main.ts |
| P2P peer-порт | 43211 | configureServer (отложенно, через 20с) |
| Heartbeat | 7с | main.ts |
| Автостарт попытки | 3, пауза 8с | main.ts |
| Watchdog: MAX_AUTO_RESTARTS / cooldown | 3 / 15с | torrserver.ts (ZONE 2) |
| Startup healthcheck | 20×500мс | torrserver.ts / jacredserver.ts |
| Стабильная проверка перед стартом | 3×/echo 300мс | torrserver.ts |
| Отложенный полный конфиг | 20с | torrserver.ts |
| apiRequest timeout | 8с (settings 5с, /echo 1с) | torrserver.ts |
| Preload Range | `bytes=0-262144000` (250MB) | PlayerModal |
| probeStream Range | `bytes=0-2097151` (2MB) | PlayerModal/сервис |
| PREBUFFER_BYTES | 80MB | PlayerModal |
| MAX_PROBE_ATTEMPTS | 30 (1.5с) | PlayerModal |
| START_TIMEOUT_MS | 5000 | PlayerModal |
| addWithRetry | 6×3000мс + restart(25с) | PlayerModal |
| Hls.js maxBufferLength / maxMaxBufferLength | 60 / 120 | PlayerModal |
| Поиск раздач дедлайн | 8с (renderer) | torrserver.ts service |
| JacRed: таймаут инстанса / дедлайн / карантин | 6с / 12с / 60с | scrapers/jacred.ts |
| JacRed remote pool TTL | 6ч | scrapers/jacred.ts |
| KinoBox/Kodik таймаут | 6с, MAX_RESOLVE=8, кэш 10мин | onlineBalancers.ts |
| VK scrape таймаут | 4с, MIN_DURATION_S=600, лимит 6 | vkScraper.ts / vkVideoService.ts |
| VK сессия TTL | 12ч | vksession.ts |
| RuTracker: дедлайн / кэш / watcher | 60с / 30мин(3мин пустой) / 4с | rutrackerSession.ts |
| TMDB: MIN_CATALOG / срез | 20 / 40 | tmdb.ts |
| Каталог-прокси кэш | 5 мин | catalog-proxy.ts |
| Дебаунс поиска / скрытие контролов | 350мс / 3.5с | App/Player |
| History limit | 50 | library.ts |

---

## 12. CRITICAL_RULES — резюме Зон (полный текст в `apps/desktop/CRITICAL_RULES.md`)

| Зона | Файл | Правило (не нарушать) |
|---|---|---|
| **ZONE 1** 🔴 | `electron/torrserver.ts` | Порядок старта: стабильная проверка /echo → бинарник → xattr → killall+lsof → **удалить settings.json** → chmod → spawn `--ip 0.0.0.0` → healthcheck 10с → configure без порта → через 20с с портом 43211 |
| **ZONE 2** 🔴 | `electron/torrserver.ts` | Watchdog по логам (EACCES/bind/bbolt/BT-not-connected/DHT/disk) + лимиты 3/15с. Не смягчать. |
| **ZONE 3** 🔴 | `src/components/PlayerModal.tsx` | Непрерывная предзагрузка /stream, probe 2MB, skip-буферизация по HTTP 200, addWithRetry(6,3000), pickVideoIndex по расширению+размеру, zero-speed детектор 5с/15с |
| **ZONE 4** 🔴 | `torrserver.ts normalizeTorrentLink` | «Всеядный» нормализатор — не ужесточать валидацию (BTIH/hex/base32/http — всё пропускать) |
| **ZONE 5** 🔴 | `electron/main.ts` | IPC-статус только из `checkHealth`+`isStarting`+`getLastError`; push из автозапуска/start/stop/restart/heartbeat/resume; keep-alive не трогает ручную остановку; single-instance lock |
| **ZONE 6** 🔴 | логирование | `userData/torrserver.log` + префиксы `[TorrServer Log]`/`[TorrServer API Error]` — не удалять логирование |
| **ZONE 7** 🟡 | кодеки | MKV/HEVC/AC3/DTS/TrueHD не играются Chromium → gst-HLS → /stream → VLC/IINA; Hls.js только для HLS; gst-имя `TorrServer-gst-…` |
| **ZONE 8** 🟡 | TMDB/год | `discover` для top-rated, `extractYear` (1900..текущий, никогда не подставлять системный год), постеры напрямую |

**Регламент:** перед любой правкой читать CRITICAL_RULES целиком; если правка трогает ZONE 1–6 — описать «Зона N, риск регрессии: …»; не переписывать целые файлы (PlayerModal ~3050, torrserver.ts ~1070); не удалять логи; E2E минимум: старт→online, add→не 500 и скорость>0, повторный запуск, `npm run selftest`.

---

## 13. Известные проблемы / хрупкие места (по итогам аудита)

1. **`onlineBalancers.ts` cacheKey без `kodikToken`** — баг: включённый позже Kodik-токен 10 минут не работает.
2. **Мёртвый код / дубли**: `catalogService`, `onlinePlayersService`, IPC `findPlayers`/`vkSearchVideo`/`fetchImage`/`removeTorrServerTorrent` не используются; `queryJacRed` — заглушка; `preBufferMB` в настройках не читается (плеер хардкодит 80MB); `VkSessionManager.searchVideos` — не вызван.
3. **Хрупкие селекторы скрейперов**: BitSearch (Tailwind-классы), Rutor (`#index tr`), RuTracker (`b.seedmed`), catalog-proxy (regex HTML), vkScraper (regex JSON) — ломаются при редизайне сайтов.
4. **Безопасность**: `webSecurity: false` в BrowserWindow; `rejectUnauthorized: false` в catalog-proxy; креды RuTracker/VK/Kodik в plaintext (localStorage + конфиг JacRed); скрытые BrowserWindow без ограничений навигации; `--ip 0.0.0.0` TorrServer в сеть; `killall -9 TorrServer` убивает чужие инстансы.
5. **PlayerModal** — монолит с effect-цепочками (легко сломать тайминги).
6. **Демо-фолбэки маскируются под реальность**: демо-магнеты, демо-каталог, `demo-hash-12345`, фейковые пиры `{active_peers||12}/{total_peers||48}`.
7. **Зависимость от сторонних API** без SLA: kinobox.tv, kodikapi.com, torrentio.strem.fun, v3-cinemeta, yandex.ru/video, публичные JacRed-зеркала, GitHub raw (jacred-instances.txt).
8. **Ресурсы**: `.torrent`-файлы и tmp-кэш gst не чистятся; localStorage пишется на каждое изменение библиотеки без дебаунса.
9. **Jacredserver**: regex-редактирование YAML-конфига; креды plaintext; нет логов (только lastError); bundled-ветка бинарника мертва (нет в extraResources).
10. **`main.ts` хардкодит порты** (8090/9117) в статусах — не читает `manager.port`.

---

## 14. Текущее состояние WIP (незакоммиченные изменения)

В рабочем дереве есть **незакоммиченный редизайн карточек раздач** (4 файла, −461/+243 строк):

- `src/components/TorrentSelector.tsx` — вычищен (убраны HealthRing-SVG, иконки Play/Search, DubbingType, sanitizeTrackerName, keyActivate), оставлены чипы + TorrentCard.
- `src/components/TorrentCard.tsx` — новый дизайн карточки (+150).
- `src/styles/index.css` — чистка стилей (−197).
- `src/utils/torrentParser.ts` — +1 строка: добавлен чип `REMUX`.

`npm run selftest` (tsc фронт + electron) — **проходит без ошибок**. Редизайн вероятно относится к последнему коммиту `0da7173` («TorrentCard redesign») и, судя по diff, продолжается.

---

## 15. Сборка и релизы

```bash
# Зависимости + проверка типов
npm --prefix apps/desktop install
npm run desktop:selftest                # tsc --noEmit + tsc -p tsconfig.electron.json --noEmit

# Бинарники TorrServer (не в git, качаются с GitHub YouROK/TorrServer)
npm run fetch:torrserver -- --platform darwin   # или win32 / linux / --all

# Сборка и упаковка
npm run desktop:build:mac    # .dmg + .zip x64+arm64
npm run desktop:build:win    # NSIS + portable .exe
npm run desktop:pack         # electron-builder --dir
```

- **electron-builder**: appId `com.luminary.torrentcinema`, asar, extraResources `resources/torrserver → Resources/torrserver` (снаружи asar, чтобы exec напрямую). Без подписи (`CSC_IDENTITY_AUTO_DISCOVERY=false`). macOS hardenedRuntime + entitlements.
- **CI (release.yml)**: тег `v*` или `workflow_dispatch` → mac-раннер (dmg+zip), windows-раннер (nsis+portable) → `gh release create` (tag) или draft.
- **Roadmap**: Android (Capacitor, `apps/android`), Android TV (leanback), подпись (notarization/code-signing/keystore).

---

## 16. Git-история (что за чем стояло)

```
08c3375  Initial commit (торрент-кинотеатр)
4fd634e  Fix TorrServer playback: TMDB-first catalog, buffering, P2P speed, status sync
5ff76e3  Refactor player & library; self-healing + CRITICAL_RULES.md
8b68ecd  priority RU torrents, Lampa metadata badges, return to selector on close, AC3 transcode
1e1e491  Hls.js + TorrServer-gst, adaptive codecs fallback
b5164cd  center HeroBanner, M1 perf (memo), RuTracker real magnets
ded08b1  heartbeat /echo 7s, auto-recovery ZONE 2 limits, manual-stop flag, powerMonitor resume
f1a8dcc  VK Video HLS, JacRed failover (instance pool), RuTracker via JacRed, app logo
cccc323  MKV audio switcher, episode resume, codec auto-transcode, VLC/IINA button, VK token
5f2c8fd  zero-config: JacRed mirror pool (CDN/Gist), BitSearch in main, silent VK guest session
7e32819  in-app JacRed instance + browser-session RuTracker
eb48659  tokenless VK Video (vkstream proxy), stable ranked RuTracker + cache, gst transcode, online balancers
5ea2a63  monorepo apps/desktop + GitHub Actions CI
0da7173  bulletproof RuTracker + TorrentCard redesign (текущий HEAD)
```

**Паттерн истории:** почти каждый коммит — «фикс рецидива» + новая ZONE в CRITICAL_RULES. Любое «упрощение» механизмов старта/буферизации/поиска почти наверняка вернёт один из зафиксированных багов.

---

## 17. Практические правила для работы в этом коде

1. **Читать `CRITICAL_RULES.md` перед каждой задачей**; зоны 1–6 — границы.
2. **Не переписывать целиком** PlayerModal / torrserver.ts / scraper.ts — только точечные правки.
3. **Не удалять логирование** — единственный инструмент диагностики рецидивов.
4. **Не ужесточать валидацию** ссылок и **не уменьшать Range/таймауты** предзагрузки.
5. Типы между renderer и electron дублируются — при изменении обновлять **оба места** (или сразу выносить в общий слой, но это отдельная рефактор-задача).
6. Новые скрейперы/зеркала: таймаут ≤ 6-8с, никогда не ронять поиск (всегда `[]`/демо), дедуп по BTIH.
7. Новые IPC-каналы: preload.ts + types/index.ts + main.ts + сервис — 4 точки, не забыть.
8. Проверки перед сдачей: `npm run desktop:selftest`, запуск, TorrServer → Online, add не 500, повторный запуск.
9. Новый циклический рецидив → добавить ZONE в CRITICAL_RULES (см. раздел 3 документа).
10. Коммиты с описанием «почему» (русский язык проекта).
