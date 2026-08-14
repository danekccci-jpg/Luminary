#!/usr/bin/env node
/**
 * Заменяет стандартные иконки Capacitor на иконку Luminary (build/icon.png).
 * Копирует 1024x1024 PNG во все mipmap-директории.
 * Android сам уменьшает до нужного размера при сборке.
 */
const fs = require('fs');
const path = require('path');

const SRC_ICON = path.join(__dirname, '..', 'build', 'icon.png');
const RES_DIR = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

if (!fs.existsSync(SRC_ICON)) {
  console.error('❌ build/icon.png not found');
  process.exit(1);
}

const densities = ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi'];

let count = 0;
for (const dir of densities) {
  const targetDir = path.join(RES_DIR, dir);
  if (!fs.existsSync(targetDir)) continue;

  // ic_launcher.png — основная иконка
  fs.copyFileSync(SRC_ICON, path.join(targetDir, 'ic_launcher.png'));

  // ic_launcher_round.png — круглая версия (Android использует круглые иконки)
  fs.copyFileSync(SRC_ICON, path.join(targetDir, 'ic_launcher_round.png'));

  // ic_launcher_foreground.png — foreground для adaptive icon
  fs.copyFileSync(SRC_ICON, path.join(targetDir, 'ic_launcher_foreground.png'));

  count += 3;
}

// Создаём ic_launcher.xml для adaptive icon (Android 8+)
const adaptiveDir = path.join(RES_DIR, 'mipmap-anydpi-v26');
if (fs.existsSync(adaptiveDir)) {
  const icLauncher = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>`;
  fs.writeFileSync(path.join(adaptiveDir, 'ic_launcher.xml'), icLauncher);

  const icLauncherRound = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>`;
  fs.writeFileSync(path.join(adaptiveDir, 'ic_launcher_round.xml'), icLauncherRound);
  count += 2;
}

// Обновляем цвет фона в values/ic_launcher_background.xml
const bgColorsDir = path.join(RES_DIR, 'values');
const bgFile = path.join(bgColorsDir, 'ic_launcher_background.xml');
if (fs.existsSync(bgFile)) {
  const bgContent = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#0A0B0E</color>
</resources>`;
  fs.writeFileSync(bgFile, bgContent);
}

console.log(`✅ Set Luminary icon: ${count} files copied + adaptive icons configured`);
