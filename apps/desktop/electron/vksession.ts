/**
 * vksession.ts — Silent VK Auth (Zero-Config).
 *
 * Автоматически получает гостевую VK-сессию через скрытый BrowserWindow
 * (vk.com → сбор cookies), кэширует её на 12 часов и обновляет при просрочке.
 * Сессия используется для поиска видео без ручного ввода токена:
 *   - если пользователь задал VK Access Token — он имеет приоритет;
 *   - без токена — гостевые cookies + внутренние страницы VK (m.vk.com/video).
 *
 * ВАЖНО: VK официально не выдаёт анонимные access_token для api.vk.com —
 * гостевой сессии достаточно для открытых публичных видео, но поиск может
 * вернуть пусто (VK закрывает анонимов). Система тихо деградирует на
 * страничный поиск renderer'а, без ошибок в UI.
 */

import { BrowserWindow, net } from 'electron';

export interface VkVideoCandidate {
  ownerId: string;
  videoId: string;
  hash?: string;
  title?: string;
}

interface VkSession {
  cookieHeader: string;
  at: number;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов
const ACQUIRE_TIMEOUT_MS = 15000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/** Извлечь кандидатов-видео из HTML страницы поиска VK (мобильной/desktop). */
function parseVkPage(html: string): VkVideoCandidate[] {
  const map = new Map<string, VkVideoCandidate>();
  const add = (ownerId: string, videoId: string, hash?: string, title?: string) => {
    const key = `${ownerId}_${videoId}`;
    const cur = map.get(key) || { ownerId, videoId };
    if (hash && !cur.hash) cur.hash = hash;
    if (title && !cur.title) cur.title = title;
    map.set(key, cur);
  };
  const linkRe = /\/video(-?\d+)_(\d+)(?:[^"'\s<>]*?hash=([a-zA-Z0-9]{8,}))?/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) add(m[1], m[2], m[3]);
  const dataIdRe = /(?:data-id|data-video-id|data-vid)="(-?\d+)_(\d+)"/g;
  while ((m = dataIdRe.exec(html))) add(m[1], m[2]);
  const jsonRe = /"video_id"\s*:\s*(-?\d+)\s*,\s*"owner_id"\s*:\s*(-?\d+)/g;
  while ((m = jsonRe.exec(html))) add(m[2], m[1]);
  return [...map.values()];
}

export class VkSessionManager {
  private cached: VkSession | null = null;
  private acquiring: Promise<VkSession | null> | null = null;

  /** Текущая сессия (с кэшем и авто-обновлением по TTL). */
  async getSession(force = false): Promise<VkSession | null> {
    if (!force && this.cached && Date.now() - this.cached.at < SESSION_TTL_MS) return this.cached;
    if (this.acquiring) return this.acquiring;
    this.acquiring = this.acquire().finally(() => { this.acquiring = null; });
    return this.acquiring;
  }

  /** Сбросить сессию (просрочка/ошибка авторизации) — следующий вызов пересоздаст. */
  invalidate() {
    this.cached = null;
  }

  /** Скрытое окно → vk.com → гостевые cookies (sessionid, remixlang, …). */
  private async acquire(): Promise<VkSession | null> {
    let win: BrowserWindow | null = null;
    try {
      win = new BrowserWindow({
        show: false,
        width: 700,
        height: 600,
        webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
      });
      await Promise.race([
        win.loadURL('https://vk.com/', { userAgent: UA }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('load timeout')), ACQUIRE_TIMEOUT_MS)),
      ]);
      // Дожидаемся конца загрузки (страховка 8 с), затем собираем cookies
      if (win.webContents.isLoading()) {
        await new Promise<void>((resolve) => {
          win!.webContents.once('did-stop-loading', () => resolve());
          setTimeout(resolve, 8000);
        });
      }
      const cookies = await win.webContents.session.cookies.get({ url: 'https://vk.com' });
      if (cookies.length === 0) return null;
      this.cached = {
        cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
        at: Date.now(),
      };
      console.log(`[VK] Silent auth: гостевая сессия получена (${cookies.length} cookies)`);
      return this.cached;
    } catch (err: any) {
      console.warn('[VK] Silent auth failed:', err?.message || err);
      return null;
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
    }
  }

  /** Поиск видео: официальный API (токен) → гостевые cookies (m.vk.com). */
  async searchVideos(query: string, token?: string): Promise<VkVideoCandidate[] | null> {
    const q = String(query || '').trim().slice(0, 200);
    if (!q) return [];

    // 1) Официальный API с токеном (main обходит CORS renderer'а)
    if (token) {
      try {
        const url =
          `https://api.vk.com/method/video.search?q=${encodeURIComponent(q)}` +
          `&sort=2&hd=1&adult=0&count=12&v=5.199&access_token=${encodeURIComponent(token)}`;
        const res = await net.fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9' } });
        const data = await res.json().catch(() => null);
        if (data && !data.error && Array.isArray(data.response?.items)) {
          return data.response.items
            .filter((it: any) => it && it.owner_id != null && it.id != null)
            .map((it: any) => ({
              ownerId: String(it.owner_id),
              videoId: String(it.id),
              hash: (String(it.player || '').match(/hash=([a-zA-Z0-9]+)/) || [])[1],
              title: it.title ? String(it.title) : undefined,
            }));
        }
        if (data?.error) console.warn('[VK] API error:', data.error.error_msg || data.error);
      } catch { /* пробуем гостевую сессию ниже */ }
    }

    // 2) Гостевая сессия: m.vk.com/video + cookies
    const s = await this.getSession();
    if (!s) return null;
    const tryPage = async (cookie: string) => {
      const res = await net.fetch(
        `https://m.vk.com/video?q=${encodeURIComponent(q)}&section=search&al=0`,
        { headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept-Language': 'ru-RU,ru;q=0.9' } }
      );
      if (!res.ok) return null;
      return { html: await res.text(), status: res.status };
    };
    try {
      const first = await tryPage(s.cookieHeader);
      if (!first) return null;
      const cands = parseVkPage(first.html);
      if (cands.length > 0) return cands;
      // Пустой результат + признак логина → сессия протухла: обновляем и повторяем
      if (/login|auth|авториз/i.test(first.html)) {
        this.invalidate();
        const s2 = await this.getSession(true);
        if (s2) {
          const second = await tryPage(s2.cookieHeader);
          if (second) return parseVkPage(second.html);
        }
      }
      return cands;
    } catch (err: any) {
      console.warn('[VK] Guest search failed:', err?.message || err);
      return null;
    }
  }
}
