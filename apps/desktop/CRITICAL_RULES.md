# ⚠️ CRITICAL_RULES.md — Архитектурный регламент Luminary

> **ОБЯЗАТЕЛЬНО К ПРОЧТЕНИЮ** любым AI-агентом или разработчиком **ПЕРЕД началом работ** с UI, плеером, TorrServer, поиском/каталогом TMDB.
>
> Этот документ фиксирует «узкие места» приложения, которые **уже неоднократно ломались** и чинились. Нарушение границ из секции «No-Touch / High-Risk Zones» с высокой вероятностью вернёт один из регрессионных багов, перечисленных ниже. Если вы нашли **новую** циклически повторяющуюся проблему — **добавьте её в этот документ** (см. раздел «Как обновлять»).

---

## 0. Карта взаимодействия (кто с кем говорит)

```
Renderer (React)
 ├── PlayerModal.tsx  ── addMagnet / getStreamUrl / getTorrentStats / probeStream / reconnect / restartServer
 │                      └── НЕПРЕРЫВНАЯ ПРЕДЗАГРУЗКА (fetch + чтение тела /stream)
 ├── App.tsx          ── torrserver:status, push-событие torrserver-status-changed, library (localStorage)
 └── MovieDetailsModal ── findPlayers, searchTorrents
        │  IPC (preload.ts → main.ts)
        ▼
Main Process (electron/main.ts)
 ├── torrserver:add  ── normalizeTorrentLink() → POST /torrents (TorrServer API)
 ├── torrserver:status / start / stop / restart / reconnect / get-logs
 ├── notifyTorrServerStatus() → 'torrserver-status-changed'
 └── TorrServerManager (electron/torrserver.ts) ── spawn/start/stop/watchdog
        │  HTTP :8090
        ▼
TorrServer MatriX (Go-бинарник, extraResources)
 └── /echo /torrents /settings /stream — BT-клиент anacrolix
```

---

## 1. NO-TOUCH / HIGH-RISK ZONES

### 🔴 ZONE 1 — `electron/torrserver.ts`: жизненный цикл старта (`startServer`)

**Текущий ПРАВИЛЬНЫЙ порядок (не менять!):**

```
1. Стабильная проверка /echo: 3 × (checkHealth + 300мс).
   → Если true: «already running» → spawn SKIPPED, статус сразу online.
2. getOrDownloadBinary(): bundled extraResources → userData/bin (копия) → download.
3. macOS: xattr -r -d com.apple.quarantine (снять Gatekeeper).
4. Жёсткая очистка: killall -9 TorrServer; lsof -ti:8090 (safeExecKill, никогда process.pid).
5. УДАЛИТЬ torrserver_data/settings.json И settings.db (сброс настроек, в т.ч. stale TorrentDisconnectTimeout:30).
6. ensureExecutable → fs.chmodSync(binPath, 0o755).
7. spawn: --port 8090 --ip 0.0.0.0 --path <dataDir>  (0.0.0.0 ОБЯЗАТЕЛЬНО).
8. Healthcheck: 20 × 500мс (10 сек) на /echo → ready.
9. Сразу: configureServer(1024, applyPeersPort=false)   ← БЕЗ смены P2P-порта.
10. Через 20 сек: configureServer(1024, applyPeersPort=true) ← порт 43211.
```

**ПОЧЕМУ нельзя менять:**
- **Пункт 5 (сброс settings.json)** — корень бага «BT client not connected → 500 на add». TorrServer читает сохранённый в `settings.json` `PeersListenPort: 43211` **сразу при старте** и это ломает инициализацию BT-клиента (anacrolix). Приложение **каждый следующий запуск** падало с 500, пока не добавили сброс + `StoreSettingsInJson: false`.
- **Пункт 9-10 (отложенный порт)** — применение `PeersListenPort` в первые секунды после `/echo` (клиент ещё инициализируется) даёт тот же «BT client not connected». Порт можно менять **только после полной инициализации** (~20 сек).
- **Пункт 4 (killall/lsof)** — убивает зависшие зомби-процессы и освобождает bboltDB-локи. Удаление → повторные инстансы на 8090, «address already in use» / «Error open bboltDB». Вызовы обёрнуты в `safeExecKill()` (try/catch + фильтр PID: только валидные числовые, никогда `process.pid`) — ошибки CLI-утилит в песочницах/ограниченных средах НЕ должны ронять главный процесс (SIGKILL при холодном старте).
- **Пункт 3 (xattr)** — без него Gatekeeper блокирует исполнение бинарника (EACCES).
- **Пункт 7 (0.0.0.0)** — bind только на 127.0.0.1 → входящие P2P-подключения не работают → скорость 0.0 MB/s.

**Регрессии при нарушении:** 500 «BT client not connected», зависание «Запуск сервиса...», зомби-процессы, двойные инстансы (single-instance lock в main.ts это частично страхует), 0.0 MB/s.

---

### 🔴 ZONE 2 — `electron/torrserver.ts`: watchdog по логам (`analyzeLogLine`, `scheduleRestart`)

**Закреплённые паттерны (добавлять новые можно, удалять/смягчать — НЕТ):**

| Строка в stderr TorrServer | Действие |
|---|---|
| `EACCES` / `permission denied` | `chmod 755` бинарника |
| `address already in use` / `bind` / `EADDRNOTAVAIL` | `killProcessOnPort(8090)` + `scheduleRestart('port-in-use')` |
| `bboltdb` / `database is locked` / `another process` | kill на порту + `scheduleRestart('db-lock')` |
| `bt client not connected` / `timeout connection get torrent info` | **ТОЛЬКО лог, НИКАКОГО рестарта** — временное состояние при add (клиент переподключается после rem/drop). Ретраит `addWithRetry` в PlayerModal. Рестарт здесь обрывал просмотр («зависает каждые 3-5 минут») |
| `dht.*0 nodes` / `upnp.*error` / `nat.?pmp.*fail` | `applyNetworkSettings()` (DHT/UPnP/PeX on, порт 43211) |
| `file write error` / `disk cache` | `applyRamCache()` (CacheSize 200MB, UseDisk:false) |

**Защита от лавины:** `MAX_AUTO_RESTARTS = 3`, `RESTART_COOLDOWN_MS = 15000` — **не увеличивать агрессивно**, иначе цикл рестартов замаскирует реальную проблему.

**ПОЧЕМУ:** это слой самолечения. Ранее каждую из этих ошибок чинили «вручную» и она возвращалась при следующем запуске (особенно `BT client not connected`). Watchdog — последняя линия защиты: даже если причина повторится, сервер перезапустится сам (со сбросом settings.json из Zone 1).

**Регрессии:** убрать watchdog → зависший BT-клиент/порт/БД не лечится, 500 возвращается, пользователь вынужден перезапускать приложение вручную.

---

### 🔴 ZONE 3 — `src/components/PlayerModal.tsx`: буферизация и предзагрузка

**Неприкосновенные механизмы:**

1. **Непрерывная предзагрузка ВСЁ время просмотра** — `startPreload(url, offset)`: чанки по 256 MB (`CHUNK_BYTES`), прочитал чанк → сразу следующий, до конца файла. Работает и ПОСЛЕ выхода из буферизации ( НЕ останавливать при `isBuffering=false` — раньше останавливали → TorrServer переставал качать → видео зависало через ~15 мин, когда буфер hls.js кончался). TorrServer не качает без читателя.
2. **РАННИЙ preload** — стартует СРАЗУ после add (index=1), НЕ ждать file_stats (для magnet метаданные качаются 5-15с — иначе скорость висит на 0). При позднем file_stats: если index ≠ 1 → `restartPreload` с новым URL, иначе не трогать (guard `preloadRef.controller`).
3. **`probeStream` Range = `bytes=0-2097151` (2 MB)** — не уменьшать до `bytes=0-1`: маленький Range не форсирует загрузку.
4. **«Пропустить буферизацию»** — `handleSkipBuffering()`: НЕ монтирует пустой `<video>`, а ждёт HTTP 200/206 от потока (`streamReady`).
5. **Ретрай add** — `addWithRetry(6, 3000)` + при упорном «BT client not connected» → `restartServer()` (IPC `torrserver:restart`) и повторный цикл. BT-клиент инициализируется ~20-30 сек после старта — ретраи обязательны. Перед add — `consumePrefetch(magnet)`: если префетч уже добавил торрент, hash берётся из кэша (без повторного add).
6. **Выбор видео-файла** — `pickVideoIndex()`: по расширению (mp4/mkv/avi/…) и наибольшему размеру, **НЕ index=1**. В раздачах первым файлом часто идёт `.srt` субтитр → `content-type: text/srt` → чёрный экран/зависание. Учитывать поздние метаданные (пересборка URL при появлении `file_stats`).
7. **Zero-speed детектор**: рестарт торрента (`rem+add`, reconnect) на 5-й и 15-й секунде при 0 MB/s + `restartPreload()`. Срабатывает максимум 2 раза за просмотр (restartedOnce/Twice).
8. **Сетевая устойчивость**: `onNetworkChanged` (смена IP из main) + `navigator.onLine/offline` → `resetNetwork()` + `restartPreload`. HLS NETWORK_ERROR — exponential backoff 1.2→2.4→4.8с, затем fallback нативный /stream.

**Регрессии при нарушении:** экран буферизации навсегда на 0.0 MB/s, чёрный экран, «субтитр вместо видео», бесконечное ожидание после «Смотреть».

---

### 🔴 ZONE 4 — `electron/torrserver.ts`: `normalizeTorrentLink` (всеядный нормализатор)

**Нельзя ужесточать валидацию!** Ссылки, которые ОБЯЗАНЫ проходить (ранее блокировались и чинились):

- `magnet:?xt=urn:btih:<40hex|32b32>&dn=…&tr=…` — полный
- `urn:btih:<hash>` — **без `magnet:`** (приходит от парсеров)
- `magnet:xt=urn:btih:…` — **без `?`**
- голый 40-hex / 32-base32
- `http(s)://…` (ссылка на .torrent)
- хэш с префиксами: `btih:`, `xt=urn:btih:`, `urn:btmh:` (v2)

Правило: **если в строке есть валидный BTIH (40 hex / 32 base32) или HTTP-адрес — отправлять в TorrServer**, а не блокировать. `extractBtih()` ищет хэш внутри произвольной строки. Блокировать («Некорректная торрент-ссылка») можно только полный мусор.

**Регрессии:** «Ошибка добавления торрента: неверный формат раздачи или битый magnet-link» для рабочих раздач.

---

### 🔴 ZONE 5 — `electron/main.ts`: IPC-статус и push-события

- **`torrserver:status`** обязан возвращать `{ running, starting, error, errorLog }` — актуальные из Main Process (`checkHealth` + `isStarting()` + `getLastError()`).
- **Push-событие `torrserver-status-changed`** (`notifyTorrServerStatus`) — вызывается из: автозапуска (`startTorrServerAsync`), `torrserver:start`, `torrserver:stop`, `torrserver:restart`, **heartbeat** (`heartbeatTick`) и **`powerMonitor.on('resume')`** (выход из сна macOS). UI (App.tsx) подписан через `onTorrServerStatusChanged`.
- **Keep-Alive Service** (`startHeartbeat`, интервал 7 с): `heartbeatTick()` → `checkHealth()` (`/echo`), при смене состояния — push в UI (индикатор меняется без клика); если сервер упал и это НЕ ручная остановка (`isManuallyStopped`, флаг `setManualStop` в `torrserver:stop`) и НЕ идёт штатный старт (`isStarting`) — авто-восстановление через `keepAliveRestart()` → `scheduleRestart` (лимиты ZONE 2: `MAX_AUTO_RESTARTS=3`, cooldown 15 с — НЕ увеличивать).
- **`torrserver:status`** обязан возвращать `{ running, starting, error, errorLog }` — актуальные из Main Process (`checkHealth` + `isStarting()` + `getLastError()`). Индикатор в UI отражает ТОЛЬКО подтверждённый `/echo` (все push-источники используют `checkHealth`).
- **`torrserver:add`**: валидация через `normalizeTorrentLink` → защита payload от undefined (`title || 'Movie Stream'`, `poster || ''`) → маппинг 500 в «Ошибка добавления торрента: неверный формат раздачи или битый magnet-link».
- **`app.requestSingleInstanceLock()`** — защита от двойных инстансов.

**Регрессии:** рассинхрон статуса (UI показывает Online/Offline неверно, «Запуск сервиса...» зависает), двойные инстансы, дублирующиеся TorrServer на 8090.

---

### 🔴 ZONE 6 — Сквозное логирование (`appendLog` → `userData/torrserver.log`)

- Весь stdout/stderr TorrServer пишется в `~/Library/Application Support/luminary/torrserver.log` + дублируется в консоль (`[TorrServer Log]`).
- Ошибки API — в `apiRequest`: `[TorrServer API Error <code>]: <body>` (тело ответа 500 часто пустое — но префикс обязателен для диагностики).
- IPC `torrserver:get-logs` + кнопка «Посмотреть логи TorrServer» в настройках.

**Не удалять и не заворачивать в «тихий» catch без логирования** — это единственный инструмент диагностики рецидивов.

---

### 🟡 ZONE 7 — Кодеки/контейнеры (Chromium)

- MKV + HEVC/AC3/DTS/TrueHD **не играются** Chromium (Electron) — это не баг, а ограничение.
- Правила: `transcodeAudioToAac` (gst HLS, если бинарник -gst) → fallback на обычный `/stream` (в `ensureStream`) → fallback VLC/IINA (`openInExternalPlayer`).
- `onError` + 5-сек детектор → оверлей «Неподдерживаемый формат видео/кодек. Откройте через VLC».
- `codecRisk` — только информирует, не блокирует.
- **Hls.js (`src/components/PlayerModal.tsx`)**: HLS-URL (`/gst/master.m3u8` от MatriX.gst, `/stream?hls=true`) воспроизводится через `Hls` (MSE), а не нативный `src`. Нативный путь — только для обычного `/stream`. Оверлей VLC/IINA — ТОЛЬКО после фатальной ошибки Hls.js (3 авто-retry на сетевые, MEDIA_ERROR → сразу оверлей). Адаптация потока — в `useEffect` на `streamUrl` (не трогать `startPreload`/`probeStream`/`addWithRetry`/`pickVideoIndex` из ZONE 3).
- **gst-бинарник**: `TorrServer-gst-<plat>-<arch>` (имя в релизах YouROK: `TorrServer-gst-…`, НЕ `TorrServer-…-gst`); gst-сборки есть для darwin/linux/windows (amd64/arm64). `getOrDownloadBinary()` предпочитает gst (bundled extraResources `resources/torrserver/` → userData/bin), флаг `-gst` при spawn НЕ передаётся (сборка уже с GStreamer).

**Регрессии:** убрать fallback → пользователь остаётся без способа посмотреть MKV/AC3.

---

### 🟡 ZONE 8 — TMDB-данные и год

- `getTopRatedMovies()`: **использовать `discover/movie?sort_by=vote_average.desc&vote_count.gte=300`**, НЕ `/movie/top_rated?language=ru` (отдаёт региональную смесь с новинками текущего года → «2026 у старых фильмов»).
- Год извлекать через `extractYear()` (`src/utils/year.ts`): строго YYYY (первые 4 цифры), диапазон 1900…текущий, **никогда не подставлять системный год**. Применять в MovieCard/HeroBanner/MovieDetailsModal/catalog.
- Постеры — прямые URL `image.tmdb.org` (CORS разрешён), без IPC-проксирования.

---

## 2. Регламент для AI-агентов и разработчиков

**Перед началом ЛЮБЫХ работ** (UI, плеер, TorrServer, TMDB, IPC):
1. **Прочитай этот файл целиком.** Зоны из секции 1 — границы, которые нельзя пересекать без явного обоснования и регрессионных тестов.
2. Если правка затрагивает Zone 1–6 — опиши в ответе: «Зона N, риск регрессии: …» и прогони E2E (см. ниже).
3. **Не «упрощай» то, что выглядит избыточным**: сброс settings.json, отложенный порт, непрерывная предзагрузка, ретраи, watchdog — каждый элемент добавлен из-за реального рецидива.
4. **Не переписывай целые файлы** (PlayerModal ~1100 строк, torrserver.ts ~700) — точечные правки.
5. Не удаляй логирование «для чистоты» — оно есть для диагностики.

**Обязательный E2E перед сдачей (минимум):**
- Приложение стартует, TorrServer → Online (`/echo 200`), статус в UI не «Запуск сервиса...» дольше ~15 сек.
- `add` торрента (magnet) → не 500; после буферизации скорость > 0 (не 0.0 MB/s).
- Повторный перезапуск приложения — сервер снова поднимается (проверка settings.json).
- `npm run selftest` (tsc фронт + electron) — без ошибок.

---

## 3. Как обновлять этот документ

Если ты (агент/разработчик) обнаружил **новую циклически повторяющуюся проблему** (чинили ≥2 раза или причина была неочевидна и всплыла из логов):

1. Добавь новую подсекцию в соответствующую зону или создай **ZONE N+1** по шаблону:
   ```
   ### 🔴 ZONE N — <название узла>
   **Симптом:** <что видел пользователь>
   **Корень:** <что реально происходило>
   **Правило (не менять):** <что именно зафиксировать>
   **Регрессии:** <что сломается при нарушении>
   ```
2. Укажи дату и краткое описание правки в `git log` (сообщение коммита) для трассируемости.
3. Не удаляй старые зоны — дополняй. История рецидивов — ценность документа.
4. Убедись, что новый паттерн покрыт `analyzeLogLine` (если это runtime-ошибка TorrServer) или E2E-проверкой.

---

*Последнее обновление: 2026-08-16 (bt-client рестарт убран; preload непрерывный чанками + ранний старт + прогрев префетча; configureServer 1024MB/250 коннектов; TorrentDisconnectTimeout 86400 — 0 НЕ принимается; heartbeat 3 фейла × 3с; сетевая устойчивость resetNetwork). Сводка состояния проекта — STATE.md.*
