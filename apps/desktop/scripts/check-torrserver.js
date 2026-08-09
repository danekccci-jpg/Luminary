#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 *  Luminary — TorrServer diagnostic script
 *
 *  Проверяет:
 *    1. Наличие бинарника (bundled extraResources / userData / переданный путь)
 *    2. Размер файла и права на исполнение (chmod 755)
 *    3. Реальный запуск бинарника с корректными аргументами
 *       (--port/--ip/--path) и healthcheck GET /echo → 200 OK
 *
 *  Использование:
 *    node scripts/check-torrserver.js                 # авто-поиск бинарника
 *    node scripts/check-torrserver.js /path/to/binary # явный путь
 *    node scripts/check-torrserver.js --install       # скачать бинарник в resources/torrserver
 *
 *  Exit code: 0 — OK, 1 — ошибка
 * ═══════════════════════════════════════════════════════════════
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const BINARY_NAME =
  process.platform === 'win32'
    ? process.arch === 'ia32' ? 'TorrServer-windows-386.exe' : 'TorrServer-windows-amd64.exe'
    : process.platform === 'darwin'
      ? process.arch === 'arm64' ? 'TorrServer-darwin-arm64' : 'TorrServer-darwin-amd64'
      : process.arch === 'arm64' ? 'TorrServer-linux-arm64' : 'TorrServer-linux-amd64';

const DOWNLOAD_URL = `https://github.com/YouROK/TorrServer/releases/latest/download/${BINARY_NAME}`;

const candidates = [
  path.join(process.cwd(), 'resources', 'torrserver', BINARY_NAME),
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Luminary', 'bin', BINARY_NAME)
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || '', 'Luminary', 'bin', BINARY_NAME)
      : path.join(os.homedir(), '.config', 'Luminary', 'bin', BINARY_NAME),
].filter(Boolean);

let pass = true;
const fail = (msg) => { console.error('  ❌ ' + msg); pass = false; };
const ok = (msg) => console.log('  ✅ ' + msg);

console.log(`\n🔍 TorrServer check — binary: ${BINARY_NAME} (${process.platform}/${process.arch})\n`);

// ── CLI: --install downloads the binary ──
if (process.argv.includes('--install')) {
  console.log('⬇️  Downloading official TorrServer binary...');
  const destDir = path.join(process.cwd(), 'resources', 'torrserver');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, BINARY_NAME);
  const res = spawnSync('curl', ['-sL', '-o', dest, DOWNLOAD_URL], { stdio: 'inherit', timeout: 300000 });
  if (res.status !== 0) { fail(`Download failed (curl exit ${res.status})`); process.exit(1); }
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  console.log(`  ✅ Downloaded → ${dest} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB)\n`);
}

// ── 1. Locate binary ──
if (process.argv[2] && !process.argv[2].startsWith('--')) candidates.unshift(path.resolve(process.argv[2]));
const binary = candidates.find((c) => c && fs.existsSync(c));

if (!binary) {
  console.error('  ❌ Бинарник TorrServer не найден. Искал:');
  candidates.forEach((c) => console.error(`     - ${c}`));
  console.error('\n  💡 Скачай его:\n     node scripts/check-torrserver.js --install\n');
  process.exit(1);
}
ok(`Бинарник найден: ${binary}`);

// ── 2. Size + permissions ──
const stat = fs.statSync(binary);
const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
ok(`Размер: ${sizeMB} MB`);

if (process.platform !== 'win32') {
  const isExec = !!(stat.mode & 0o111);
  if (isExec) {
    ok(`Права на исполнение: есть (mode ${(stat.mode & 0o777).toString(8)})`);
  } else {
    fail(`Нет прав на исполнение (mode ${(stat.mode & 0o777).toString(8)}). Пробую chmod 755...`);
    try {
      fs.chmodSync(binary, 0o755);
      ok('chmod 755 выполнен');
    } catch (e) {
      fail('chmod не удался: ' + e.message);
      process.exit(1);
    }
  }
} else {
  ok('Платформа Windows — права не проверяются');
}

// ── 3. Real spawn + /echo healthcheck ──
const port = 18192 + Math.floor(Math.random() * 500);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luminary-tscheck-'));
const args = ['--port', String(port), '--ip', '127.0.0.1', '--path', tmpDir];
console.log(`\n🚀 Пробный запуск: ${path.basename(binary)} ${args.join(' ')}`);

const child = spawn(binary, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ...(process.platform === 'darwin' ? { DYLD_LIBRARY_PATH: '' } : {}) },
});
let output = '';
child.stdout.on('data', (d) => (output += d.toString()));
child.stderr.on('data', (d) => (output += d.toString()));
child.on('exit', (code, signal) => {
  if (pass && code !== null) {
    fail(`Бинарник завершился раньше времени (code=${code}, signal=${signal}).\n${output.slice(-800)}`);
    process.exit(1);
  }
});

function pingEcho(attempt) {
  const req = http.get({ hostname: '127.0.0.1', port, path: '/echo', timeout: 800 }, (res) => {
    res.resume();
    if (res.statusCode === 200) {
      ok(`Healthcheck /echo → 200 OK (попытка ${attempt})`);
      console.log(`\n══════════════════════════════════════`);
      console.log('  ✅ TorrServer работает корректно!');
      console.log(`  Port: ${port}, PID: ${child.pid}`);
      console.log('══════════════════════════════════════\n');
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      process.exit(0);
    } else {
      retry(attempt);
    }
  });
  req.on('error', () => retry(attempt));
  req.on('timeout', () => { req.destroy(); retry(attempt); });
}

let retried = 0;
function retry(attempt) {
  if (retried >= 10) {
    fail(`Нет ответа от /echo после 10 попыток.\n${output.slice(-800)}`);
    try { child.kill('SIGKILL'); } catch {}
    process.exit(1);
  }
  retried++;
  setTimeout(() => pingEcho(retried + 1), 500);
}

setTimeout(() => pingEcho(1), 1500);
