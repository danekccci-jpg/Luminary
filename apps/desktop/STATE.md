# Luminary — сводка состояния (2026-08-16)

> Компактный снимок: что уже работает стабильно (не трогать без причины) и что отложено.
> Регламент ошибок/зон — в `CRITICAL_RULES.md` (обязателен к прочтению).

## Стек

Electron 33 + React (renderer, стили inline/CSS-классы, Tailwind НЕТ) + TorrServer MatriX.142.2 gst (порт 8090, P2P 43211) + TMDB (каталог) + локальный JacRed (порт 9117) + RuTracker через скрытое BrowserWindow (`persist:rutracker`, dl.php → BTIH, браузерный поиск). Монорепо `apps/desktop`. Сборка: `npm run selftest` (tsc) → `npm run build` → `npx electron-builder --dir` → `cp -R release/mac-arm64/Luminary.app /Applications/`.

## TorrServer — рабочая конфигурация (проверена live)

CacheSize 1024MB · ConnectionsLimit 250 · ReaderReadAHead 98 · PreloadBufferSize 30MB · **TorrentDisconnectTimeout 86400** (0 НЕ принимается → дефолт 30!) · EnableIPv6 true · UseDisk true (gst требует файл; путь БЕЗ пробелов `/tmp/luminary_ts`). settings.json И settings.db удаляются перед spawn (stale-настройки перезаписывают API). Heartbeat: /echo каждые 7с, рестарт после 3 подряд провалов, таймаут /echo 3с.

## Поиск раздач — стабильная схема

1. **RuTracker (браузерная сессия)**: очередь single-window, RU+EN проходы ВСЕГДА с дедупом topicId, кэш 30мин/пустой 3мин, автоповтор пустого реального прохода, первый navigate 25с (CF-челлендж), дедлайн 60с, зеркала org→net→nl. Работает без логина (dl.php отдаёт .torrent гостю).
2. **Быстрый поиск** (Torrentio/Rutor/JacRed, дедлайн 8с) + RuTracker late мёржится РЕАКТИВНО: в модалке `setReleases(prev => mergeReleasesByHash(fast, prev))` — НИКОГДА не перезапись (иначе кэш RuTracker приходит мгновенно и стирается).
3. **История/Избранное**: названия с суффиксами «(4K)» — срезаются регэкспом перед поиском; `libItemToMovie` — числовой id (TMDB-обогащение восстанавливает original_title → EN-догонка).
4. **Гейт bb_session в renderer УБРАН** — поиск пробуется всегда.
5. **JacRed**: публичные трекеры rutor/bitru/torrentby/kinozal/1337x/nyaa (без логина); NNM-Club/Kinozal бЕЗ учётки невозможны (авторизация на просмотр/скачивание) — только через поля логина в настройках.

## Плеер — рабочая схема

- **Preload непрерывный ВСЁ время просмотра**: чанки 256MB подряд до конца файла, стартует СРАЗУ после add (не ждать file_stats), при позднем file_stats — restartPreload если index≠1. TorrServer не качает без читателя.
- **Префетч**: при открытии фильма лучшая раздача добавляется + `warmupStream` (Range 0-20MB, 30с) — пиры ищутся ДО клика «Смотреть». `consumePrefetch(magnet)` в PlayerModal пропускает повторный add.
- Кэш торрента НЕ дропается при закрытии плеера (мгновенный возврат).
- Звук: транскод gst AAC всегда для торрентов; gst-discoverer требует файл на диске и данные (при старте возможен «no stream info» — лечится прогревом/ретраями).
- Сеть: IP-монитор (10с, api.ipify.org) → `network-changed` → `resetNetwork()` (rem+add всех + reconfigure) + resume из сна; navigator.onLine; HLS backoff 1.2→2.4→4.8с.

## UI раздач

- `TorrentCard` (rounded-xl, теги-пилюли: качество/форматы/аудио/🎙️озвучки/💬субтитры, S/E-бейджи, светл плашка размера) + скелетоны-шиммер.
- Фильтры: качество / озвучка (авто из раздач + Гоблин/Переозвучка/Пифагор) / **формат** (HDR/DV/HEVC/…, динамический) / сортировка. Сезонный фильтр: `seasonsTo` (диапазоны S01-S03) + перепоиск RuTracker по сезону.
- `EpisodeResumeDialog`: пикер сезонов→серий с прогрессом + **пикер озвучки** (filteredReleases по selectedDubbing, авто-выбор из истории).
- `torrentParser.ts` (теги/битрейт/год) + `torrentMeta.ts` (seasonsTo, dubbingYear, Гоблин/Переозвучка, russianPriority).

## Отложено (не делать «между делом»)

- **Пикер файлов раздачи** (многодисковые паки) — требует рефактор videoIndex из локальной переменной init() в состояние PlayerModal.
- Кнопка «Скачать раздачу», копировать magnet, открыть в VLC — UI-мелочи, легко добавить по запросу.
- Дисковой кэш результатов поиска между запусками (сейчас кэш в памяти main).

## Известные ограничения (принято)

- Разгон скорости 0→10MB/s ~25с — физика BitTorrent (подключение пиров), ускорено ранним preload+прогревом.
- gst-транскод 4K Remux в реальном времени — CPU-bound; при лагах fallback нативный /stream → VLC/IINA.
- RuTracker зависит от Cloudflare; при полном блоке — зеркала, при недоступности всех — остальных источников достаточно.

## Не закоммичено (на 2026-08-16)

Всё после коммита `0da7173`: зеркала RuTracker, S/E-бейджи, фильтр форматов, префетч+прогрев, непрерывный preload, сетевая устойчивость, оптимизация TorrServer (1024MB/250), TorrentDisconnectTimeout=86400, пикер озвучки, Гоблин/Переозвучка, seasonsTo. Коммит — по запросу пользователя.
