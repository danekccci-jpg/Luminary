/**
 * jacredserver.ts — локальный JacRed-инстанс внутри приложения (Zero-Config).
 *
 * Схема — как у TorrServer: бинарник (Go, jacred-fdb) скачивается при первом
 * запуске с GitHub Releases (или берётся из bundled extraResources), спавнится
 * как дочерний процесс на http://127.0.0.1:9117. Renderer автоматически
 * добавляет локальный URL первым в пул JacRed-зеркал — RuTracker/NNM/Rutor
 * ищутся локально, без внешних (мёртвых) инстансов.
 *
 * Нюансы:
 * - Приватные трекеры (RuTracker/NNM-Club) требуют логин/пароль в веб-UI
 *   инстанса (http://127.0.0.1:9117/settings) — кнопка открытия в UI.
 * - База наполняется встроенным crontab'ом (Data/crontab) и разгоняется
 *   триггером /cron/{tracker}/parse после старта; первый поиск может быть пустым.
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { app } from 'electron';

export interface JacredServerStatus {
  running: boolean;
  port: number;
  version?: string;
  error?: string;
  /** Сервис в процессе запуска (скачивание бинарника / spawn). */
  starting?: boolean;
}

const DEFAULT_PORT = 9117;
const HOST = '127.0.0.1';
/** Сколько ждать /api/v1.0/conf после spawn (10 сек). */
const HEALTH_ATTEMPTS = 20;
const HEALTH_INTERVAL_MS = 500;

export class JacredManager {
  private child: ChildProcess | null = null;
  private port: number;
  private binaryPath = '';
  private dataDir = '';
  private startingFlag = false;
  private lastError = '';
  private crawlTriggered = false;

  constructor(port: number = DEFAULT_PORT) {
    this.port = port;
    this.dataDir = path.join(app.getPath('userData'), 'jacred_data');
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  public isStarting(): boolean {
    return this.startingFlag;
  }

  public getLastError(): string {
    return this.lastError;
  }

  /** Имя ассета релиза под текущую платформу (jacred-fdb). */
  public getAssetName(): string {
    const p = process.platform;
    const a = process.arch;
    if (p === 'darwin') return a === 'arm64' ? 'jacred-osx-arm64.zip' : 'jacred-osx-amd64.zip';
    if (p === 'win32') return a === 'arm64' ? 'jacred-win-arm64.zip' : a === 'ia32' ? 'jacred-win-x86.zip' : 'jacred-win-x64.zip';
    return a === 'arm64' ? 'jacred-linux-arm64.zip' : 'jacred-linux-amd64.zip';
  }

  public getDownloadUrl(): string {
    return `https://github.com/jacred-fdb/jacred/releases/latest/download/${this.getAssetName()}`;
  }

  /** Распаковать zip: macOS — ditto, Windows — Expand-Archive, Linux — unzip. */
  private extractZip(zipPath: string, destDir: string) {
    if (process.platform === 'darwin') {
      execSync(`ditto -x -k "${zipPath}" "${destDir}"`, { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'"`,
        { stdio: 'ignore' }
      );
    } else {
      execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'ignore' });
    }
  }

  /**
   * Приобрести бинарник: bundled extraResources (resources/jacred/) →
   * уже скачанный в userData/bin/jacred → скачать с GitHub Releases.
   * В архиве рядом с бинарником лежит Data/ (crontab, шаблоны) — сохраняем.
   */
  public async getOrDownloadBinary(): Promise<string> {
    const binDir = path.join(app.getPath('userData'), 'bin', 'jacred');
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
    const target = path.join(binDir, `JacRed-${process.platform}-${process.arch}`);
    const bundled = path.join(process.resourcesPath, 'jacred', `JacRed-${process.platform}-${process.arch}`);

    if (fs.existsSync(bundled)) {
      if (!fs.existsSync(target) || fs.statSync(bundled).size !== fs.statSync(target).size) {
        fs.copyFileSync(bundled, target);
      }
      this.binaryPath = target;
      fs.chmodSync(target, 0o755);
      return target;
    }
    if (fs.existsSync(target)) {
      this.binaryPath = target;
      fs.chmodSync(target, 0o755);
      return target;
    }

    // Скачивание + распаковка (архив содержит JacRed + Data/)
    const zipPath = path.join(binDir, this.getAssetName());
    console.log(`[Jacred] Скачивание бинарника: ${this.getDownloadUrl()}`);
    await this.downloadFile(this.getDownloadUrl(), zipPath);
    this.extractZip(zipPath, binDir);
    const extracted = path.join(binDir, 'JacRed');
    if (!fs.existsSync(extracted)) {
      throw new Error('Архив JacRed не содержит бинарник JacRed');
    }
    fs.renameSync(extracted, target);
    try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
    // Data/ из архива остаётся рядом (crontab для внутреннего планировщика)
    this.binaryPath = target;
    fs.chmodSync(target, 0o755);
    return target;
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const request = (targetUrl: string, redirectsLeft = 5) => {
        https
          .get(targetUrl, (response) => {
            if (
              (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) &&
              response.headers.location
            ) {
              if (redirectsLeft <= 0) {
                fs.unlink(destPath, () => {});
                reject(new Error('Too many redirects'));
                return;
              }
              request(response.headers.location, redirectsLeft - 1);
              return;
            }
            if (response.statusCode !== 200) {
              fs.unlink(destPath, () => {});
              reject(new Error(`HTTP status code ${response.statusCode}`));
              return;
            }
            response.pipe(file);
            file.on('finish', () => {
              file.close();
              resolve();
            });
          })
          .on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
          });
      };
      request(url);
    });
  }

  /** Health: GET /api/v1.0/conf → 200. */
  public checkHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://${HOST}:${this.port}/api/v1.0/conf`, { timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Авторизация приватных трекеров — читаем ФАЙЛ конфига (init.yaml/init.conf
   * в cwd бинарника). Через API это сделать нельзя: /api/v1.0/config РЕДАКТИРУЕТ
   * чувствительные поля (login затирается при сохранении, «sensitive data
   * redacted»), а cookie из файла сохраняется — файл единственный источник правды.
   */
  private readAuthFromFile(): { rutracker: boolean; nnmClub: boolean } {
    const status = { rutracker: false, nnmClub: false };
    if (!this.binaryPath) return status;
    const dir = path.dirname(this.binaryPath);
    const yamlPath = path.join(dir, 'init.yaml');
    const confPath = path.join(dir, 'init.conf');
    const file = fs.existsSync(yamlPath) ? yamlPath : fs.existsSync(confPath) ? confPath : null;
    if (!file) return status;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return status; }

    /** Текст секции модуля (yaml-блок или json-объект до следующего top-level ключа). */
    const sectionOf = (name: string): string => {
      const lines = text.split('\n');
      const idx = lines.findIndex((l) => new RegExp(`^${name}:|"${name}"\\s*:`).test(l.trim()));
      if (idx === -1) return '';
      const block: string[] = [];
      for (let i = idx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^\S/.test(line)) break; // следующий top-level ключ / закрывающая скобка
        block.push(line);
      }
      return block.join('\n');
    };

    /** Валидные креды: (login.u И login.p) ЛИБО cookie — непустые, не null/~/пусто. */
    const hasCreds = (sec: string): boolean => {
      if (!sec) return false;
      const val = (pat: RegExp): string => {
        const m = sec.match(pat);
        return m ? (m[1] || '').trim().replace(/^["']|["']$/g, '') : '';
      };
      const u = val(/["']?(?:u|username)["']?\s*[:=]\s*["']?([^"'\n]*)/i);
      const p = val(/["']?(?:p|password)["']?\s*[:=]\s*["']?([^"'\n]*)/i);
      const c = val(/["']?cookie["']?\s*[:=]\s*["']?([^"'\n]*)/i);
      const real = (s: string) => !!s && !/^(null|~)$/i.test(s);
      return (real(u) && real(p)) || real(c);
    };

    status.rutracker = hasCreds(sectionOf('Rutracker'));
    status.nnmClub = hasCreds(sectionOf('NNMClub'));
    return status;
  }

  private authCache: { at: number; status: { rutracker: boolean; nnmClub: boolean } } | null = null;

  /** Статус авторизации приватных трекеров (кэш 30 с) — для плашки в UI. */
  public async getAuthStatus(): Promise<{ rutracker: boolean; nnmClub: boolean }> {
    if (this.authCache && Date.now() - this.authCache.at < 30 * 1000) {
      return this.authCache.status;
    }
    const status = this.readAuthFromFile();
    this.authCache = { at: Date.now(), status };
    return status;
  }

  /** Разгон базы: триггер парсинга трекеров (не блокирует старт).
   *  Публичные (rutor/bitru/torrentby/kinozal) — всегда; приватные
   *  (rutracker/nnmclub) — автоматически, если в конфиге есть креды. */
  private async triggerInitialCrawl() {
    if (this.crawlTriggered) return;
    this.crawlTriggered = true;
    const trackers = ['rutor', 'bitru', 'torrentby', 'kinozal'];
    const auth = this.readAuthFromFile();
    if (auth.rutracker) trackers.push('rutracker');
    if (auth.nnmClub) trackers.push('nnmclub');
    const privates = trackers.filter((t) => t === 'rutracker' || t === 'nnmclub');
    if (privates.length) {
      console.log(`[Jacred] Динамический разгон: приватные трекеры с кредами — ${privates.join(', ')}`);
    }
    this.fireCrawls(trackers);
  }

  private fireCrawls(trackers: string[]) {
    for (const tracker of trackers) {
      try {
        const req = http.get(`http://${HOST}:${this.port}/cron/${tracker}/parse`, (res) => res.resume());
        req.on('error', () => {});
      } catch { /* трекер может отсутствовать — не критично */ }
    }
  }

  private lastPrivateCrawlAt = 0;

  /** Пере-триггер приватных парсеров, если креды появились ПОСЛЕ старта
   *  (пользователь ввёл их в веб-UI без перезапуска приложения). Throttle 10 мин. */
  public async syncPrivateCrawls(): Promise<void> {
    if (!this.child?.pid) return; // сервер не запущен
    if (Date.now() - this.lastPrivateCrawlAt < 10 * 60 * 1000) return;
    const auth = this.readAuthFromFile();
    const privates: string[] = [];
    if (auth.rutracker) privates.push('rutracker');
    if (auth.nnmClub) privates.push('nnmclub');
    if (privates.length) {
      // Таймстамп ставим ТОЛЬКО при реальном разгоне — иначе логин в течение
      // 10 минут после старта приложения тихо игнорировался (баг: раздач нет).
      this.lastPrivateCrawlAt = Date.now();
      console.log(`[Jacred] Креды приватных трекеров обнаружены — разгон: ${privates.join(', ')}`);
      this.fireCrawls(privates);
    }
  }

  /**
   * Сохранить креды приватного трекера в файл конфига (init.yaml/init.conf —
   * как это делает веб-UI; конфиг-API затирает login при сохранении).
   * После записи сбрасываем кэш авторизации и разгоняем парсер приватных.
   */
  public async setTrackerCredentials(
    tracker: 'rutracker' | 'nnmclub',
    creds: { username?: string; password?: string; cookie?: string }
  ): Promise<{ rutracker: boolean; nnmClub: boolean }> {
    if (!this.binaryPath) {
      throw new Error('JacRed не запущен — бинарник ещё не приобретён');
    }
    const dir = path.dirname(this.binaryPath);
    const yamlPath = path.join(dir, 'init.yaml');
    const confPath = path.join(dir, 'init.conf');
    const file = fs.existsSync(yamlPath) ? yamlPath : fs.existsSync(confPath) ? confPath : null;
    if (!file) throw new Error('Конфиг JacRed не найден');
    const isJson = file.endsWith('.conf');

    let text = fs.readFileSync(file, 'utf8');
    const sectionName = tracker === 'rutracker' ? 'Rutracker' : 'NNMClub';

    if (isJson) {
      // JSON-конфиг: точечно обновляем поля внутри секции
      const re = new RegExp(`("${sectionName}"\\s*:\\s*\\{[\\s\\S]*?)(\\})`);
      if (!re.test(text)) throw new Error(`Секция ${sectionName} не найдена в конфиге`);
      text = text.replace(re, (_m, head: string) => {
        let out = head;
        const patch = (field: string, value: string) => {
          const v = JSON.stringify(value);
          out = out.replace(new RegExp(`("${field}"\\s*:\\s*)"[^"]*"`), `$1${v}`);
          out = out.replace(new RegExp(`("${field}"\\s*:\\s*)null`), `$1${v}`);
        };
        if (creds.username !== undefined) patch('u', creds.username);
        if (creds.password !== undefined) patch('p', creds.password);
        if (creds.cookie !== undefined) patch('cookie', creds.cookie);
        return out;
      });
    } else {
      // YAML-конфиг: правим строки секции (u:/p:/cookie:), при отсутствии секции — добавляем
      const lines = text.split('\n');
      const idx = lines.findIndex((l) => l.trim() === `${sectionName}:`);
      if (idx === -1) {
        const block: string[] = [
          `${sectionName}:`,
          '  host: ' + (tracker === 'rutracker' ? 'https://rutracker.org' : 'https://nnmclub.to'),
        ];
        if (creds.cookie !== undefined) block.push(`  cookie: ${this.yamlValue(creds.cookie)}`);
        if (creds.username !== undefined) block.push('  login:', `    u: ${this.yamlValue(creds.username)}`);
        if (creds.password !== undefined) {
          if (!creds.username) block.push('  login:');
          block.push(`    p: ${this.yamlValue(creds.password)}`);
        }
        lines.push('', ...block);
      } else {
        // Меняем/добавляем поля в границах секции
        let end = lines.length;
        for (let i = idx + 1; i < lines.length; i++) {
          if (/^\S/.test(lines[i])) { end = i; break; }
        }
        const apply = (field: string, value: string) => {
          const re = new RegExp(`^(\\s*)${field}:\\s*.*$`);
          const hit = lines.slice(idx + 1, end).findIndex((l) => re.test(l));
          if (hit !== -1) {
            lines[idx + 1 + hit] = lines[idx + 1 + hit].replace(re, `$1${field}: ${this.yamlValue(value)}`);
          } else {
            // Поле отсутствует — вставляем перед концом секции (для u/p — вложенно в login:)
            if (field === 'u' || field === 'p') {
              const loginIdx = lines.slice(idx + 1, end).findIndex((l) => /^\s{2}login:\s*$/.test(l));
              if (loginIdx !== -1) {
                const li = idx + 1 + loginIdx;
                lines.splice(li + 1, 0, `    ${field}: ${this.yamlValue(value)}`);
                end++;
              } else {
                lines.splice(end, 0, '  login:', `    ${field}: ${this.yamlValue(value)}`);
                end += 2;
              }
            } else {
              lines.splice(end, 0, `  ${field}: ${this.yamlValue(value)}`);
              end++;
            }
          }
        };
        if (creds.cookie !== undefined) apply('cookie', creds.cookie);
        if (creds.username !== undefined) apply('u', creds.username);
        if (creds.password !== undefined) apply('p', creds.password);
      }
      text = lines.join('\n');
    }

    fs.writeFileSync(file, text);
    this.authCache = null; // сброс кэша статуса — следующее чтение увидит креды
    console.log(`[Jacred] Креды ${sectionName} сохранены в ${path.basename(file)}`);

    // Сразу разгоняем приватный парсер (явное действие пользователя — без throttle)
    this.fireCrawls([tracker]);
    return this.readAuthFromFile();
  }

  /** Значение в YAML: экранируем спецсимволы одинарными кавычками при необходимости. */
  private yamlValue(value: string): string {
    const v = String(value ?? '');
    if (/^[A-Za-z0-9._@+\-]+$/.test(v)) return v;
    return `'${v.replace(/'/g, "''")}'`;
  }

  /**
   * Гарантировать конфиг с нужным портом. jacred-fdb НЕ принимает аргумент
   * -port/--port — порт читается только из init.yaml (приоритет) / init.conf
   * в рабочем каталоге бинарника (cwd), с hot-reload каждые ~10 секунд.
   * Если конфиг уже существует (пользователь сохранял настройки в веб-UI) —
   * меняем ТОЛЬКО listenport, сохраняя логины/cookies приватных трекеров.
   */
  private ensureConfigPort(binDir: string) {
    const yamlPath = path.join(binDir, 'init.yaml');
    const confPath = path.join(binDir, 'init.conf');
    const existing = fs.existsSync(yamlPath) ? yamlPath : fs.existsSync(confPath) ? confPath : null;
    const setPort = (content: string) =>
      content
        .replace(/^(listenport:\s*)\d+/m, `$1${this.port}`)
        .replace(/^(\s*"listenport"\s*:\s*)\d+/m, `$1${this.port}`);
    if (existing) {
      try {
        fs.writeFileSync(existing, setPort(fs.readFileSync(existing, 'utf8')));
        console.log(`[Jacred] Config ${path.basename(existing)}: listenport → ${this.port}`);
        return;
      } catch { /* конфиг занят/недоступен — fallthrough на создание */ }
    }
    // Конфига нет — создаём из шаблона архива (Data/init.yaml) или минимальный
    try {
      const template = path.join(binDir, 'Data', 'init.yaml');
      const content = fs.existsSync(template)
        ? setPort(fs.readFileSync(template, 'utf8'))
        : `listenip: any\nlistenport: ${this.port}\n`;
      fs.writeFileSync(yamlPath, content);
      console.log(`[Jacred] Создан конфиг ${yamlPath} (listenport ${this.port})`);
    } catch (err: any) {
      console.warn('[Jacred] Не удалось создать конфиг порта:', err?.message || err);
    }
  }

  public async startServer(): Promise<JacredServerStatus> {
    // Уже работает (наш или внешний инстанс на порту) — статус online
    if (await this.checkHealth()) {
      this.startingFlag = false;
      this.lastError = '';
      return { running: true, port: this.port, version: 'JacRed (pre-running)' };
    }

    this.startingFlag = true;
    this.lastError = '';
    try {
      const binPath = await this.getOrDownloadBinary();
      // jacred-fdb игнорирует -port: пишем listenport в init.yaml/init.conf
      this.ensureConfigPort(path.dirname(binPath));

      // Очистка порта от зависших процессов.
      // ⚠️ НЕ `lsof | xargs kill -9`: lsof выводит и собственные клиентские
      // соединения приложения (checkHealth → TIME_WAIT) — self-kill главного
      // процесса (SIGKILL 137). Убиваем через JS-цикл с исключением process.pid.
      try {
        const out = execSync(`lsof -ti tcp:${this.port} || true`, {
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf8',
        });
        for (const raw of (out || '').split('\n')) {
          const n = Number(raw.trim());
          if (!Number.isFinite(n) || n <= 1 || n === process.pid) continue;
          try { process.kill(n, 'SIGKILL'); } catch { /* процесс уже умер */ }
        }
      } catch { /* порт свободен */ }

      console.log(`[Jacred] Spawn: ${binPath} -port ${this.port} -path ${this.dataDir}`);
      this.child = spawn(binPath, ['-port', String(this.port), '-path', this.dataDir], {
        cwd: path.dirname(binPath), // Data/ (crontab) рядом с бинарником
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.child.stdout?.on('data', (d) => console.log('[Jacred]', String(d).trimEnd()));
      this.child.stderr?.on('data', (d) => console.log('[Jacred]', String(d).trimEnd()));
      this.child.on('exit', (code, signal) => {
        console.log(`[Jacred] Exited code=${code} signal=${signal}`);
        this.startingFlag = false;
        this.child = null;
      });
      this.child.on('error', (err) => {
        console.error('[Jacred] Spawn error:', err.message);
        this.lastError = err.message;
        this.startingFlag = false;
      });

      // Health-check: 20 попыток × 0.5 c = 10 c
      let ready = false;
      for (let i = 0; i < HEALTH_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
        if (await this.checkHealth()) { ready = true; break; }
      }

      if (!ready) {
        this.startingFlag = false;
        try { this.child?.kill('SIGKILL'); } catch { /* ignore */ }
        this.child = null;
        this.lastError = 'JacRed не запустился за 10 секунд. Проверьте логи и порт 9117.';
        return { running: false, port: this.port, error: this.lastError };
      }

      this.startingFlag = false;
      this.triggerInitialCrawl().catch(() => {});
      console.log('[Jacred] Локальный инстанс готов: http://127.0.0.1:' + this.port);
      return { running: true, port: this.port, version: 'JacRed fdb' };
    } catch (err: any) {
      this.startingFlag = false;
      this.lastError = err?.message || String(err);
      console.error('[Jacred] Start error:', this.lastError);
      return { running: false, port: this.port, error: this.lastError };
    }
  }

  public async stopServer(): Promise<void> {
    if (!this.child?.pid) {
      this.child = null;
      return;
    }
    try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { this.child?.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 5000);
      this.child?.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
    this.crawlTriggered = false;
  }
}
