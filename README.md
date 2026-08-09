# 🌠 Luminary — Torrent Cinema

Кроссплатформенный торрент-кинотеатр на **TorrServer MatriX** + **TMDB** с онлайн-плеерами (HDRezka / Filmix / KinoBox / Kodik / VK Video) и поиском по трекерам (RuTracker / NNM-Club через JacRed).

## 📥 Скачать

Все релизы — на странице **[Releases](https://github.com/danekccci-jpg/Luminary/releases/latest)**:

| Платформа | Файл | Примечание |
|---|---|---|
| macOS (Apple Silicon) | `Luminary-*-arm64.dmg` | M1/M2/M3/M4 |
| macOS (Intel) | `Luminary-*-x64.dmg` | Intel Mac |
| Windows 10/11 | `Luminary-*-x64-Setup.exe` | установщик NSIS |
| Windows (portable) | `Luminary-*-x64-Portable.exe` | без установки |
| Android / Android TV | — | в разработке (roadmap ниже) |

> **Про подпись**: сборки неподписанные. macOS: ПКМ по приложению → **Открыть** (или «Безопасность → Всё равно открыть»). Windows: **Подробнее → Выполнить в любом случае**. Собственные бинарники TorrServer не распространяются в составе исходников — приложение само скачивает их с официальных релизов YouROK/TorrServer.

## ✨ Возможности

- 🎬 Каталог TMDB + HDRezka/Filmix, поиск, подробности фильмов и сериалов
- ⚡ Прямое стриминг-воспроизведение через TorrServer (без полного скачивания)
- 🔍 Поиск раздач: JacRed-пул (RuTracker/NNM/Rutor), Torrentio, браузерная сессия RuTracker
- 📺 Онлайн-потоки (KinoBox + Kodik) — .m3u8 без торрентов
- 🎵 VK Video без токена (агрегатор → HLS), переключение аудиодорожек MKV, кодек-транскодинг (GStreamer)
- ▶️ Внешние плееры (VLC / IINA), resume серий, избранное-библиотека

## 🗂 Структура репозитория

```
Luminary/
├── apps/
│   └── desktop/          # Electron-приложение (React + Vite + TS)
│       ├── electron/     #   main-процесс: TorrServer, JacRed, скраперы, прокси
│       ├── src/          #   React-фронтенд
│       ├── scripts/      #   fetch-torrserver.js, check-torrserver.js
│       └── resources/    #   бинарники TorrServer (скачиваются, в git не хранятся)
├── .github/workflows/    # CI: сборка .dmg/.exe → GitHub Releases
└── package.json          # обёртки: npm run desktop:build:mac ...
```

## 🔨 Сборка из исходников (desktop)

```bash
# 1. Зависимости
npm --prefix apps/desktop install

# 2. Бинарники TorrServer (не в git):
npm run fetch:torrserver -- --platform darwin   # или win32 / linux / --all

# 3. Проверка типов
npm run desktop:selftest

# 4. Сборка и упаковка
npm run desktop:build:mac   # .dmg x64 + arm64
npm run desktop:build:win   # .exe NSIS + portable
```

Подробнее: `apps/desktop/MACOS_BUILD.md`, `apps/desktop/CRITICAL_RULES.md`.

## 🤖 Релизы через GitHub Actions

Пуш тега `v*` запускает CI (`.github/workflows/release.yml`): macOS-раннер собирает `.dmg` (x64+arm64), Windows-раннер — `.exe` (NSIS+portable), затем создаётся Release со всеми артефактами. Вручную — `workflow_dispatch` собирает и публикует draft-релиз.

## 🗺 Roadmap

- [x] Desktop: macOS (.dmg) + Windows (.exe) — GitHub Releases
- [ ] **Android** — `apps/android` (Capacitor): встроенный TorrServer-android64, HTTP-адаптер сервисов вместо IPC, JacRed через зеркала
- [ ] **Android TV** — отдельный flavor (leanback, баннер 320×180, D-pad-навигация) → второй `.apk` в те же Releases
- [ ] Подпись: Apple notarization, Windows code-signing, keystore для APK

## ⚖️ Лицензия

MIT — для личного использования и образовательных целей. Ответственность за использование и соблюдение законодательства вашей страны лежит на пользователе.
