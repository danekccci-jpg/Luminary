# 🍎 Luminary — Сборка для macOS

> **Монорепо**: проект живёт в `apps/desktop/` корня репозитория.
> Все команды ниже выполняются из `apps/desktop/` (или через обёртки корневого `package.json`:
> `npm run desktop:build:mac`).

## Системные требования

| Компонент | Минимум |
|-----------|---------|
| macOS | 11 Big Sur или новее |
| Node.js | 18.x или новее |
| npm | 9.x или новее |
| Архитектура | Intel x64 или Apple Silicon arm64 |
| Место на диске | ~2 GB (node_modules + артефакты) |

---

## Быстрая сборка (рекомендуемый способ)

### Вариант А: Из zip-архива (перенос с Windows)

```bash
# 1. Скопируй luminary-mac-build.zip на Mac любым способом и распакуй:
unzip luminary-mac-build.zip -d luminary && cd luminary

# 2. Дай права на исполнение скрипту сборки:
chmod +x build-mac.sh

# 3. Запусти одним скриптом (ставит зависимости → проверяет типы → собирает .dmg):
./build-mac.sh
```

### Вариант Б: Вручную

```bash
cd luminary

# 1. Установка зависимостей
npm install

# 2. Проверка типов TypeScript
npm run selftest

# 3. Скачать бинарники TorrServer (arm64 + x64, std + gst) в resources/torrserver
node scripts/fetch-torrserver.js --platform darwin

# 4. Сборка Vite + Electron компиляция
npm run build

# 5. Упаковка .dmg для обеих архитектур
npx electron-builder --mac --x64 --arm64
```

---

## Результаты сборки

После успешного выполнения в `release/` появятся:

```
release/
├── Luminary-1.0.0-arm64.dmg    # Apple Silicon (M1/M2/M3)
├── Luminary-1.0.0-arm64.zip    # Apple Silicon (портативный)
├── Luminary-1.0.0-x64.dmg      # Intel Mac
├── Luminary-1.0.0-x64.zip      # Intel Mac (портативный)
├── mac-arm64/                  # Распакованное .app (Apple Silicon)
└── mac-x64/                    # Распакованное .app (Intel)
```

---

## Установка из .dmg

1. Дважды кликни `.dmg` файл
2. В открывшемся окне перетащи `Luminary` в папку `Applications`
3. При первом запуске macOS покажет предупреждение — это нормально для неподписанных приложений:
   - **Вариант А**: ПКМ по Luminary.app → «Открыть» → «Открыть»
   - **Вариант Б**: Системные настройки → Безопасность и конфиденциальность → «Всё равно открыть»

---

## Примечания

- **Gatekeeper**: сборка с `hardenedRuntime: true`, но без нотаризации Apple. Пользователю нужно разрешить запуск вручную (см. выше).
- **TorrServer**: бинарники (`TorrServer-darwin-arm64` / `TorrServer-darwin-amd64` / gst-варианты) лежат в `resources/torrserver/` и упаковываются в приложение через `extraResources` (папка `Resources/torrserver`). Они **не хранятся в git** — скачиваются скриптом `scripts/fetch-torrserver.js` перед сборкой (или автоматически при первом запуске приложения, если бандла нет).
- **Универсальный бинарник**: Electron упаковывает раздельные сборки для arm64 и x64. Универсальный (fat) бинарник можно собрать командой:
  ```bash
  npx electron-builder --mac --universal
  ```
