#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 *  Luminary — загрузка бинарников TorrServer для бандла
 *
 *  Скачивает официальные релизы YouROK/TorrServer в
 *  resources/torrserver/ (именно эта папка уходит в extraResources
 *  приложения через electron-builder.json5).
 *
 *  Имена файлов СОВПАДАЮТ с:
 *    1. Ассетами GitHub-релиза YouROK/TorrServer (amd64/arm64/386);
 *    2. getBinaryName() в electron/torrserver.ts — bundled-файл
 *       ищется именно по этому имени.
 *
 *  Использование:
 *    node scripts/fetch-torrserver.js --platform darwin   # macOS (arm64+x64, std+gst)
 *    node scripts/fetch-torrserver.js --platform win32    # Windows x64 (gst на Windows не используется)
 *    node scripts/fetch-torrserver.js --platform linux    # Linux (arm64+x64, std+gst)
 *    node scripts/fetch-torrserver.js --all               # все платформы
 *
 *  Exit code: 0 — все бинарники на месте, 1 — ошибка загрузки.
 * ═══════════════════════════════════════════════════════════════
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RELEASES_URL = 'https://github.com/YouROK/TorrServer/releases/latest/download';
/** Мин. «живой» размер файла, чтобы считать загрузку успешной (~1 MB). */
const MIN_SIZE = 1 * 1024 * 1024;

/** Какие бинарники нужны под какую платформу сборки. */
const PLATFORMS = {
  darwin: [
    'TorrServer-darwin-arm64',
    'TorrServer-darwin-amd64',
    'TorrServer-gst-darwin-arm64',
    'TorrServer-gst-darwin-amd64',
  ],
  // gst-сборка на Windows не используется (см. torrserver.ts getOrDownloadBinary)
  win32: ['TorrServer-windows-amd64.exe'],
  linux: [
    'TorrServer-linux-amd64',
    'TorrServer-linux-arm64',
    'TorrServer-gst-linux-amd64',
    'TorrServer-gst-linux-arm64',
  ],
  android: [
    'TorrServer-android-arm64',
    'TorrServer-android-amd64',
  ],
};

const args = process.argv.slice(2);
const platformArg =
  args.find((a) => a.startsWith('--platform='))?.split('=')[1] ||
  args[args.indexOf('--platform') + 1];
const all = args.includes('--all');

let targets = [];
if (all) {
  targets = Object.values(PLATFORMS).flat();
} else if (platformArg && PLATFORMS[platformArg]) {
  targets = PLATFORMS[platformArg];
} else {
  console.error('❌ Укажи --platform <darwin|win32|linux|android> или --all');
  process.exit(1);
}

// Android-бинарники идут в assets/ (для Capacitor APK), остальные — в resources/torrserver/
const isAndroid = platformArg === 'android' || targets.some(t => t.includes('android'));
const destDir = isAndroid
  ? path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'torrserver')
  : path.join(__dirname, '..', 'resources', 'torrserver');
fs.mkdirSync(destDir, { recursive: true });

let failed = false;
for (const name of targets) {
  const dest = path.join(destDir, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > MIN_SIZE) {
    console.log(`  ✅ уже есть: ${name} (${(fs.statSync(dest).size / 1048576).toFixed(1)} MB)`);
    continue;
  }
  const url = `${RELEASES_URL}/${name}`;
  console.log(`⬇️  ${url}`);
  const res = spawnSync('curl', ['-sL', '-o', dest, url], { timeout: 600000, stdio: ['ignore', 'pipe', 'inherit'] });
  const ok = res.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > MIN_SIZE;
  if (!ok) {
    console.error(`  ❌ не удалось скачать: ${name} (curl exit ${res.status})`);
    try { fs.unlinkSync(dest); } catch { /* нет файла */ }
    failed = true;
    continue;
  }
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  console.log(`  ✅ ${name} (${(fs.statSync(dest).size / 1048576).toFixed(1)} MB)`);
}

console.log(failed ? '\n⚠️  Часть бинарников не скачалась' : '\n✅ Все бинарники на месте');
process.exit(failed ? 1 : 0);
