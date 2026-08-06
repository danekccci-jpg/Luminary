import axios, { AxiosError } from 'axios';
import * as cheerio from 'cheerio';

/** Local copy — keeps electron build isolated from Vite `src/` rootDir. */
export type DubbingType =
  | 'ALL'
  | 'Дубляж'
  | 'RHS'
  | 'HDRezka'
  | 'LostFilm'
  | 'TVShows'
  | 'Кубик в Кубе'
  | 'Оригинал + Субтитры'
  | 'Прочее';

export interface TorrentRelease {
  id: string;
  title: string;
  originalTitle?: string;
  quality: '4K' | '1080p' | '720p' | 'SD';
  tags: string[];
  dubbing: DubbingType;
  size: string;
  sizeBytes: number;
  seeders: number;
  leechers: number;
  magnet: string;
  source: string;
  videoCodec: 'H.264' | 'HEVC' | 'AV1' | 'Unknown';
  audioCodec: 'AAC' | 'AC3' | 'EAC3' | 'DTS' | 'TrueHD' | 'Unknown';
  stabilityScore: number;
  stabilityLabel: 'Отличная' | 'Хорошая' | 'Умеренная' | 'Низкий битрэйт';
  requiredMbps: number;
  /** .torrent-файл (base64) — надёжнее магнета для TorrServer (метаданные локально). */
  torrentFile?: string;
}

export class TorrentScraper {
  /**
   * Multi-source search. Lampa-style: primaryQuery (RU title) first;
   * if no live hits, retry with fallbackQuery (original title).
   */
  public async searchTorrents(
    query: string,
    year?: string,
    jackettUrl?: string,
    jackettApiKey?: string,
    imdbId?: string,
    fallbackQuery?: string
  ): Promise<TorrentRelease[]> {
    const primary = await this.runSearchPass(query, year, jackettUrl, jackettApiKey, imdbId);
    const livePrimary = primary.filter((r) => !/\(Demo\)/i.test(r.source));

    if (livePrimary.length > 0) {
      return this.dedupeAndSort(primary);
    }

    const fb = this.sanitizeQuery(fallbackQuery || '');
    const primarySafe = this.sanitizeQuery(query);
    if (fb && fb.toLowerCase() !== primarySafe.toLowerCase()) {
      console.log(`[Scraper] Lampa fallback → original title: "${fb}"`);
      const secondary = await this.runSearchPass(fb, year, jackettUrl, jackettApiKey, imdbId);
      const liveSecondary = secondary.filter((r) => !/\(Demo\)/i.test(r.source));
      if (liveSecondary.length > 0) {
        return this.dedupeAndSort(secondary);
      }
      // Merge any demos from either pass
      return this.dedupeAndSort([...primary, ...secondary]);
    }

    return this.dedupeAndSort(primary);
  }

  private async runSearchPass(
    query: string,
    year?: string,
    jackettUrl?: string,
    jackettApiKey?: string,
    imdbId?: string
  ): Promise<TorrentRelease[]> {
    const safeQuery = this.sanitizeQuery(query);
    if (!safeQuery) {
      console.warn('[Scraper] Empty query after sanitization');
      return [];
    }

    const safeYear = this.sanitizeYear(year);
    console.log(`[Scraper] Multi-source search for "${safeQuery}" (${safeYear || 'any year'})...`);

    const results: TorrentRelease[] = [];
    const sources: Array<{ name: string; run: () => Promise<TorrentRelease[]> }> = [
      // JacRed (RuTracker / NNM-Club / Rutor) вынесен в renderer:
      // src/services/scrapers/jacred.ts — динамический пул + racing-опрос, мёрдж
      // с этой выдачей происходит в src/services/torrserver.ts (по BTIH-хэшу).
      { name: 'Torrentio', run: () => this.queryTorrentio(safeQuery, safeYear, imdbId) },
      { name: 'Rutor', run: () => this.scrapeRutor(safeQuery, safeYear) },
      { name: 'BitSearch', run: () => this.scrapeBitSearch(safeQuery, safeYear) },
      // RuTracker — открытые зеркала (Zero-Config Fallback): перебор пула
      // зеркал/RSS в обход login-wall; защищённые (DDos-Guard/JS) молча
      // пропускаются. Глубокий поиск RuTracker — через локальный JacRed
      // с кредами (renderer + динамический разгон в jacredserver.ts).
      { name: 'RuTrackerMirror', run: () => this.scrapeRuTrackerMirrors(safeQuery, safeYear) },
      // VK Video НЕ источник торрентов: раньше генерировал фейковые magnet
      // (btih из нулей) → битые «раздачи» в UI. Реальный VK-поиск (HLS-потоки)
      // вынесен в renderer — src/services/vkVideoService.ts (блок «Онлайн / VK»).
    ];

    if (jackettUrl && jackettApiKey) {
      sources.push({
        name: 'Jackett',
        run: () => this.queryJackett(safeQuery, safeYear, jackettUrl, jackettApiKey),
      });
    }

    const settled = await Promise.allSettled(sources.map((s) => s.run()));
    settled.forEach((outcome, i) => {
      const name = sources[i].name;
      if (outcome.status === 'fulfilled') {
        results.push(...outcome.value);
        console.log(`[Scraper] ${name}: ${outcome.value.length} results`);
      } else {
        console.warn(`[Scraper] ${name} fallback skip:`, this.formatAxiosError(outcome.reason));
      }
    });

    if (results.length === 0) {
      console.warn('[Scraper] Pass empty — local demo fallback for this query');
      results.push(...this.generateFallbackReleases(safeQuery, safeYear));
    }

    return results;
  }

  private dedupeAndSort(results: TorrentRelease[]): TorrentRelease[] {
    const unique = new Map<string, TorrentRelease>();
    for (const item of results) {
      if (!item.magnet) continue;
      const hashMatch = item.magnet.match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
      const key = hashMatch ? hashMatch[1].toLowerCase() : `${item.title}|${item.size}`;
      const prev = unique.get(key);
      if (!prev || item.seeders > prev.seeders) {
        unique.set(key, item);
      }
    }
    const finalResults = Array.from(unique.values());
    // Приоритет русскоязычных раздач (кириллица/студии/RU-трекеры) — как в UI
    finalResults.sort((a, b) => {
      const ruB = this.russianBonus(b) - this.russianBonus(a);
      if (ruB !== 0) return ruB;
      return b.seeders - a.seeders || b.stabilityScore - a.stabilityScore;
    });
    return finalResults;
  }

  /** Бонус приоритета русскоязычных раздач: кириллица, RU-студии озвучки, RU-трекеры. */
  private russianBonus(r: TorrentRelease): number {
    let score = 0;
    if (/[а-яё]/i.test(r.title)) score += 40; // русское название раздачи
    if (/дубляж|\brhs\b|hdrezka|lostfilm|tvshows|кубик в кубе/i.test(r.title)) score += 40; // RU-озвучка
    if (/rutracker|rutor|jacred/i.test(r.source)) score += 20; // русскоязычные трекеры
    return score;
  }

  /** Strip punctuation Lampa-style: colons, dashes, quotes → spaces; keep letters/digits. */
  private sanitizeQuery(query: string): string {
    return String(query || '')
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/[<>"`«»„"']/g, ' ')
      .replace(/[:;|/\\_+.,!?()[\]{}]/g, ' ')
      .replace(/[—–−‐-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  }

  private sanitizeYear(year?: string): string | undefined {
    if (!year) return undefined;
    const m = String(year).match(/\b(19|20)\d{2}\b/);
    return m ? m[0] : undefined;
  }

  private formatAxiosError(err: unknown): string {
    if (axios.isAxiosError(err)) {
      const ax = err as AxiosError;
      const status = ax.response?.status;
      if (status) return `HTTP ${status}`;
      if (ax.code === 'ECONNABORTED') return 'timeout';
      return ax.message;
    }
    return err instanceof Error ? err.message : String(err);
  }

  private async queryJacRed(query: string, year?: string): Promise<TorrentRelease[]> {
    // Удалено: JacRed вынесен в renderer — src/services/scrapers/jacred.ts
    // (пул публичных инстансов + авто-фолбэк, фильтр трекеров RuTracker/NNM/Rutor,
    // 4K-приоритизация). Мёрдж с локальной выдачей — в src/services/torrserver.ts.
    return [];
  }

  /**
   * Torrentio needs an IMDb id (`tt…`). Resolve via Cinemeta when missing.
   * Never hardcode a demo film id.
   */
  private async queryTorrentio(
    query: string,
    year?: string,
    imdbId?: string
  ): Promise<TorrentRelease[]> {
    let id = imdbId && /^tt\d+$/i.test(imdbId) ? imdbId : undefined;

    if (!id) {
      id = await this.resolveImdbId(query, year);
    }
    if (!id) {
      console.warn('[Scraper] Torrentio skipped — no IMDb id for query');
      return [];
    }

    const url = `https://torrentio.strem.fun/stream/movie/${encodeURIComponent(id)}.json`;
    const response = await axios.get(url, {
      timeout: 5000,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const streams = Array.isArray(response.data?.streams) ? response.data.streams : [];
    const searchStr = year ? `${query} ${year}` : query;

    return streams
      .filter((st: any) => st?.infoHash)
      .map((st: any, i: number) => {
        const title = `${searchStr} [${st.name || 'HD'}] ${st.title || ''}`.trim();
        const magnet = `magnet:?xt=urn:btih:${st.infoHash}&dn=${encodeURIComponent(searchStr)}`;
        const seedersMatch = String(st.title || '').match(/👤\s*(\d+)/);
        const seeders = seedersMatch ? parseInt(seedersMatch[1], 10) : 25;
        const sizeMatch = String(st.title || '').match(/💾\s*([\d.]+)\s*(GB|MB)/i);
        const sizeBytes = sizeMatch
          ? this.parseSizeBytes(`${sizeMatch[1]} ${sizeMatch[2]}`)
          : 5 * 1024 * 1024 * 1024;

        return this.normalizeRelease(
          `torrentio-${id}-${i}`,
          title,
          magnet,
          sizeBytes,
          seeders,
          3,
          'Torrentio Network'
        );
      });
  }

  private async resolveImdbId(query: string, year?: string): Promise<string | undefined> {
    try {
      const url = `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(query)}.json`;
      const res = await axios.get(url, { timeout: 4000 });
      const metas: any[] = Array.isArray(res.data?.metas) ? res.data.metas : [];
      if (metas.length === 0) return undefined;

      let best = metas[0];
      if (year) {
        const byYear = metas.find((m) => String(m.releaseInfo || m.year || '').includes(year));
        if (byYear) best = byYear;
      }

      const raw = String(best.imdb_id || best.id || '');
      return /^tt\d+$/i.test(raw) ? raw : undefined;
    } catch (e: any) {
      console.warn('[Scraper] Cinemeta IMDb resolve failed:', e.message);
      return undefined;
    }
  }

  private async scrapeRutor(query: string, year?: string): Promise<TorrentRelease[]> {
    const searchStr = year ? `${query} ${year}` : query;
    // Пул зеркал Rutor (публичный, без авторизации)
    const mirrors = [
      `http://rutor.info/search/0/0/100/0/${encodeURIComponent(searchStr)}`,
      `http://rutor.is/search/0/0/100/0/${encodeURIComponent(searchStr)}`,
    ];

    let response;
    let lastErr: unknown;
    for (const url of mirrors) {
      try {
        response = await axios.get(url, {
          timeout: 5500,
          validateStatus: (s) => s >= 200 && s < 300,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!response) {
      if (lastErr) throw lastErr;
      return [];
    }

    const $ = cheerio.load(response.data);
    const releases: TorrentRelease[] = [];

    $('#index tr').each((i, el) => {
      if (i === 0) return;
      const cells = $(el).find('td');
      if (cells.length < 3) return;

      const titleCell = $(cells[1]);
      const titleText = titleCell.text().trim();
      const magnetLink = titleCell.find('a[href^="magnet:"]').attr('href');

      if (!magnetLink || !titleText) return;

      const sizeText = $(cells[cells.length - 2]).text().trim();
      const seedText = $(cells[cells.length - 1]).find('span.green').text().trim() || '0';
      const leechText = $(cells[cells.length - 1]).find('span.red').text().trim() || '0';

      releases.push(
        this.normalizeRelease(
          `rutor-${i}-${Date.now()}`,
          titleText,
          magnetLink,
          this.parseSizeBytes(sizeText),
          parseInt(seedText, 10) || 0,
          parseInt(leechText, 10) || 0,
          'Rutor Tracker'
        )
      );
    });

    return releases;
  }

  // ═══════════════════════════════════════════════════════
  //  BitSearch.to — magnet прямо в списке результатов (без капчи)
  // ═══════════════════════════════════════════════════════
  private async scrapeBitSearch(query: string, year?: string): Promise<TorrentRelease[]> {
    const searchStr = year ? `${query} ${year}` : query;
    const url = `https://bitsearch.to/search?q=${encodeURIComponent(searchStr)}`;

    let html = '';
    try {
      const res = await axios.get(url, {
        timeout: 7000,
        validateStatus: (s) => s >= 200 && s < 300,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
      });
      html = res.data;
    } catch {
      return []; // BitSearch недоступен — молча пропускаем
    }

    const $ = cheerio.load(html);
    const releases: TorrentRelease[] = [];
    const seenMagnet = new Set<string>();

    // Карточка результата: div.flex.items-start.justify-between (по одной на раздачу)
    $('.flex.items-start.justify-between').each((i, el) => {
      if (releases.length >= 8) return false;

      // magnet:?xt=urn:btih:...&dn=... (в HTML сущности &#x3D;/&amp;)
      let magnet = $(el).find('a[href^="magnet:"]').first().attr('href') || '';
      magnet = magnet.replace(/&#x3D;/g, '=').replace(/&amp;/g, '&').trim();
      if (!magnet.startsWith('magnet:?xt=urn:btih:')) return;
      if (seenMagnet.has(magnet)) return;
      seenMagnet.add(magnet);

      // Название: блок line-clamp-2 / ссылка-заголовок
      const titleText =
        $(el).find('div[class*="line-clamp-2"]').first().text().trim() ||
        $(el).find('a[class*="hover:text-primary"]').first().text().trim() ||
        $(el).find('a[href*="/torrents/"]').first().text().trim();
      if (!titleText) return;

      // Сиды (зелёные) / личи (красные)
      const seedText = $(el).find('span[class*="text-green-600"]').first().text().trim() || '0';
      const leechText = $(el).find('span[class*="text-red-600"]').first().text().trim() || '0';

      // Размер: «3.75 GB» в мета-блоке карточки
      const sizeText = ($(el).find('div[class*="gap-4"]').first().text().match(/([\d.]+\s*(?:GB|MB|TB))/i) || [])[1] || '1 GB';

      releases.push(
        this.normalizeRelease(
          `bitsearch-${i}-${Date.now()}`,
          titleText,
          magnet,
          this.parseSizeBytes(sizeText),
          parseInt(seedText.replace(/\D/g, ''), 10) || 0,
          parseInt(leechText.replace(/\D/g, ''), 10) || 0,
          'BitSearch'
        )
      );
    });

    return releases;
  }

  private async queryJackett(
    query: string,
    year: string | undefined,
    jackettUrl: string,
    apiKey: string
  ): Promise<TorrentRelease[]> {
    const searchStr = year ? `${query} ${year}` : query;
    const cleanUrl = jackettUrl.replace(/\/$/, '');
    const reqUrl = `${cleanUrl}/api/v2.0/indexers/all/results?apikey=${encodeURIComponent(
      apiKey
    )}&Query=${encodeURIComponent(searchStr)}`;

    // Jackett/Prowlarr со всеми indexer'ами: приватные RU-трекеры (NNM-Club,
    // CinemaZ, Megapeer) приходят, если пользователь добавил их в Jackett
    // с авторизацией. Запрос идёт по `all` — сортировка по сидам ниже (dedupeAndSort).
    const res = await axios.get(reqUrl, {
      timeout: 7000,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const results = Array.isArray(res.data?.Results) ? res.data.Results : [];

    return results
      .map((item: any, i: number) =>
        this.normalizeRelease(
          `jackett-${i}`,
          item.Title || searchStr,
          item.MagnetUri || item.Link || '',
          item.Size || 4 * 1024 * 1024 * 1024,
          item.Seeders || 0,
          item.Peers || 0,
          item.Tracker || 'Jackett'
        )
      )
      .filter((r: TorrentRelease) => r.magnet.startsWith('magnet:'));
  }

  // ═══════════════════════════════════════════════════════
  //  RuTracker — открытые зеркала (Zero-Config Fallback).
  //  rutracker.org/.net/.nl закрыты DDos-Guard/JS-челленджами для гостей —
  //  перебираем ПУЛ зеркал (tracker.php + rss.php) и молча пропускаем
  //  защищённые. Когда зеркало открыто — отдаём title/BTIH/size/seeders
  //  в общий dedupeAndSort. Строки без magnet (гостевой режим) отбрасываем:
  //  без infoHash раздачу не воспроизвести.
  //  Глубокий поиск RuTracker с учётом озвучки/серий — локальный JacRed
  //  с кредами (см. jacredserver.ts: динамический разгон при наличии логина).
  // ═══════════════════════════════════════════════════════
  private async scrapeRuTrackerMirrors(query: string, year?: string): Promise<TorrentRelease[]> {
    const searchStr = year ? `${query} ${year}` : query;
    const q = encodeURIComponent(searchStr);
    const mirrorUrls = [
      `https://rutracker.net/forum/tracker.php?nm=${q}`,
      `https://rutracker.org/forum/tracker.php?nm=${q}`,
      `https://rutracker.nl/forum/tracker.php?nm=${q}`,
    ];
    const rssUrls = [
      'https://rutracker.net/forum/rss.php',
      'https://rutracker.org/forum/rss.php',
    ];
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept-Language': 'ru-RU,ru;q=0.9',
    };

    // 1) Поисковые страницы зеркал (tracker.php?nm=...) — ПАРАЛЛЕЛЬНО,
    //    общий кап ~6 с: зависшее зеркало не должно тормозить выдачу.
    const mirrorFetches = await Promise.allSettled(
      mirrorUrls.map((url) =>
        axios
          .get(url, { timeout: 5500, validateStatus: (st) => st >= 200 && st < 300, headers })
          .then((res) => ({ url, html: res.data }))
      )
    );
    for (const outcome of mirrorFetches) {
      if (outcome.status !== 'fulfilled') continue;
      const { url, html } = outcome.value;
      if (!html || typeof html !== 'string' || html.length < 500) continue;
      const $ = cheerio.load(html);
      const releases: TorrentRelease[] = [];
      $('tr.tCenter.hl-tr, tr.tCenter').each((i, el) => {
        if (releases.length >= 10) return false;
        const titleText = $(el).find('a.tLink, a.med.tLink').first().text().trim();
        if (!titleText) return;
        const magnet = $(el).find('a[href^="magnet:"]').first().attr('href') || '';
        // Гость не видит magnet-иконку — строка без BTIH бесполезна для плеера
        if (!/^magnet:\?xt=urn:btih:/i.test(magnet)) return;
        const sizeText =
          $(el).find('a.tor-size, td.tor-size').first().text().trim() ||
          $(el).find('td').eq(5).text().trim();
        const seedText = $(el).find('b.seedmed, span.seedmed').first().text().trim() || '0';
        const leechText = $(el).find('b.leechmed, span.leechmed').first().text().trim() || '0';
        releases.push(
          this.normalizeRelease(
            `rutracker-${i}-${Date.now()}`,
            titleText,
            magnet,
            this.parseSizeBytes(sizeText),
            parseInt(seedText, 10) || 0,
            parseInt(leechText, 10) || 0,
            'RuTracker Mirror'
          )
        );
      });
      if (releases.length > 0) {
        console.log(`[Scraper] RuTrackerMirror: ${url} → ${releases.length} results`);
        return releases;
      }
    }

    // 2) RSS-фиды зеркал: парсим только записи с magnet (гостевой RSS rutracker
    //    магнетов не отдаёт — фид тихо пропускается, но код живёт на случай,
    //    если зеркало откроет magnet в фиде).
    for (const url of rssUrls) {
      try {
        const res = await axios.get(url, {
          timeout: 6000,
          validateStatus: (s) => s >= 200 && s < 300,
          headers,
        });
        const $ = cheerio.load(res.data, { xmlMode: true });
        const releases: TorrentRelease[] = [];
        $('item').each((i, el) => {
          if (releases.length >= 10) return false;
          const titleText = $(el).find('title').first().text().trim();
          const html = $(el).html() || '';
          const magnet = (html.match(/magnet:\?xt=urn:btih:[a-fA-F0-9]{40}/i) || [])[0] || '';
          if (!titleText || !magnet) return;
          releases.push(
            this.normalizeRelease(
              `rutracker-rss-${i}-${Date.now()}`,
              titleText,
              magnet,
              4 * 1024 * 1024 * 1024,
              0,
              0,
              'RuTracker Mirror'
            )
          );
        });
        if (releases.length > 0) return releases;
      } catch {
        /* фид недоступен — пропускаем */
      }
    }

    return [];
  }

  // ═══════════════════════════════════════════════════════
  //  VK Video — перенесён в renderer (src/services/vkVideoService.ts):
  //  реальный поиск по VK + извлечение HLS-манифеста из playerParams.
  //  Здесь больше не создаём фейковые magnet-раздачи (btih из нулей).
  // ═══════════════════════════════════════════════════════

  /** Публичная обёртка нормализации (переиспользуется rutrackerSession.ts). */
  public normalize(
    title: string,
    magnet: string,
    sizeBytes: number,
    seeders: number,
    leechers: number,
    source: string
  ): TorrentRelease {
    const id = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.normalizeRelease(id, title, magnet, sizeBytes, seeders, leechers, source);
  }

  private normalizeRelease(
    id: string,
    title: string,
    magnet: string,
    sizeBytes: number,
    seeders: number,
    leechers: number,
    source: string
  ): TorrentRelease {
    const quality = this.detectQuality(title);
    const tags = this.detectTags(title);
    const dubbing = this.detectDubbing(title);
    const videoCodec = this.detectVideoCodec(title);
    const audioCodec = this.detectAudioCodec(title);

    const safeBytes = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 4 * 1024 * 1024 * 1024;
    const safeSeeders = Math.max(0, Number.isFinite(seeders) ? seeders : 0);
    const safeLeechers = Math.max(0, Number.isFinite(leechers) ? leechers : 0);

    // ~110 min default runtime; guard division by zero
    const durationSeconds = 110 * 60;
    const requiredMbps =
      Math.round(((safeBytes * 8) / durationSeconds / (1024 * 1024)) * 10) / 10;

    // Stability Score 0–100: seed supply vs bitrate demand
    const seedFactor = Math.min(100, Math.max(0, safeSeeders * 4));
    const bitrateFactor = Math.min(100, Math.max(10, 100 - requiredMbps * 1.5));
    const stabilityScore = Math.min(
      100,
      Math.max(0, Math.round(seedFactor * 0.6 + bitrateFactor * 0.4))
    );

    let stabilityLabel: 'Отличная' | 'Хорошая' | 'Умеренная' | 'Низкий битрэйт' = 'Умеренная';
    if (stabilityScore >= 80) stabilityLabel = 'Отличная';
    else if (stabilityScore >= 55) stabilityLabel = 'Хорошая';
    else if (requiredMbps > 65) stabilityLabel = 'Низкий битрэйт';

    return {
      id,
      title,
      quality,
      tags,
      dubbing,
      size: this.formatSizeBytes(safeBytes),
      sizeBytes: safeBytes,
      seeders: safeSeeders,
      leechers: safeLeechers,
      magnet,
      source,
      videoCodec,
      audioCodec,
      stabilityScore,
      stabilityLabel,
      requiredMbps,
    };
  }

  private detectDubbing(title: string): DubbingType {
    const t = title.toLowerCase();
    if (/дубляж|\bdub\b|лицензия|\bitunes\b/.test(t)) return 'Дубляж';
    if (/\brhs\b|red head sound/.test(t)) return 'RHS';
    if (/hdrezka|\brezka\b/.test(t)) return 'HDRezka';
    if (/lostfilm/.test(t)) return 'LostFilm';
    if (/tvshows/.test(t)) return 'TVShows';
    if (/кубик в кубе|\bkubik\b/.test(t)) return 'Кубик в Кубе';
    if (/оригинал|\bsubtitles?\b|\benglish\b/.test(t)) return 'Оригинал + Субтитры';
    return 'Прочее';
  }

  /** Word-boundary quality detection — avoid bare "hd" matching HDR / HDRezka. */
  private detectQuality(title: string): '4K' | '1080p' | '720p' | 'SD' {
    const t = title.toLowerCase();
    if (/\b2160p\b|\b4k\b|\buhd\b|\b3840\s*[x×]\s*2160\b/.test(t)) return '4K';
    if (/\b1080p\b|\b1080i\b|\bfull.?hd\b|\b1920\s*[x×]\s*1080\b/.test(t)) return '1080p';
    if (/\b720p\b|\b1280\s*[x×]\s*720\b/.test(t)) return '720p';
    return 'SD';
  }

  private detectTags(title: string): string[] {
    const t = title.toLowerCase();
    const tags: string[] = [];
    if (/dolby.?vision|\bdv\b/.test(t)) tags.push('Dolby Vision');
    if (/hdr10\+/.test(t)) tags.push('HDR10+');
    else if (/\bhdr10\b|\bhdr\b/.test(t)) tags.push('HDR');
    if (/\bremux\b/.test(t)) tags.push('REMUX');
    if (/web-?dl/.test(t)) tags.push('WEB-DL');
    if (/bdrip|blu-?ray/.test(t)) tags.push('BDRip');
    return tags;
  }

  private detectVideoCodec(title: string): 'H.264' | 'HEVC' | 'AV1' | 'Unknown' {
    const t = title.toLowerCase();
    if (/\bav1\b/.test(t)) return 'AV1';
    if (/\bhevc\b|\bx265\b|\bh\.?265\b/.test(t)) return 'HEVC';
    if (/\bx264\b|\bh\.?264\b|\bavc\b/.test(t)) return 'H.264';
    return 'Unknown';
  }

  private detectAudioCodec(title: string): 'AAC' | 'AC3' | 'EAC3' | 'DTS' | 'TrueHD' | 'Unknown' {
    const t = title.toLowerCase();
    if (/truehd|\batmos\b/.test(t)) return 'TrueHD';
    if (/\bdts\b/.test(t)) return 'DTS';
    if (/\beac3\b|\bdd\+/.test(t)) return 'EAC3';
    if (/\bac3\b|\bdd5\.1\b/.test(t)) return 'AC3';
    if (/\baac\b/.test(t)) return 'AAC';
    return 'Unknown';
  }

  private parseSizeBytes(sizeStr: string): number {
    const match = sizeStr.match(/([\d.]+)\s*(GB|MB|KB|TB|ГБ|МБ|КБ|ТБ)/i);
    if (!match) return 4 * 1024 * 1024 * 1024;
    const val = parseFloat(match[1]);
    if (!Number.isFinite(val) || val < 0) return 4 * 1024 * 1024 * 1024;
    const unit = match[2].toUpperCase();
    if (unit.startsWith('T') || unit.startsWith('Т')) return val * 1024 * 1024 * 1024 * 1024;
    if (unit.startsWith('G') || unit.startsWith('Г')) return val * 1024 * 1024 * 1024;
    if (unit.startsWith('M') || unit.startsWith('М')) return val * 1024 * 1024;
    return val * 1024;
  }

  private formatSizeBytes(bytes: number): string {
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)} MB`;
  }

  private generateFallbackReleases(query: string, year?: string): TorrentRelease[] {
    const qStr = year ? `${query} (${year})` : query;
    return [
      this.normalizeRelease(
        'fallback-4k-1',
        `${qStr} [2160p 4K UHD] [Dolby Vision & HDR10+] [REMUX] [HEVC x265] [Дубляж RHS 5.1 + Eng]`,
        `magnet:?xt=urn:btih:e2467cbf021192c241367b892230dc5037d89001&dn=${encodeURIComponent(qStr)}+4K`,
        24.8 * 1024 * 1024 * 1024,
        185,
        14,
        'JacRed Aggregator (Demo)'
      ),
      this.normalizeRelease(
        'fallback-1080p-1',
        `${qStr} [1080p FullHD] [WEB-DL] [x264] [Озвучка HDRezka Studio] [AC3 5.1]`,
        `magnet:?xt=urn:btih:08da7015a846347d46922970f5b73015db5e9da6&dn=${encodeURIComponent(qStr)}+1080p`,
        7.2 * 1024 * 1024 * 1024,
        340,
        22,
        'Rutor Tracker (Demo)'
      ),
      this.normalizeRelease(
        'fallback-1080p-2',
        `${qStr} [1080p] [BDRip] [Дубляж Лицензия] [H.264] [AAC]`,
        `magnet:?xt=urn:btih:a1b2c3d4e5f60718293a4b5c6d7e8f901234abcd&dn=${encodeURIComponent(qStr)}+Dub`,
        4.5 * 1024 * 1024 * 1024,
        210,
        8,
        'Torrentio Network (Demo)'
      ),
      this.normalizeRelease(
        'fallback-720p-1',
        `${qStr} [720p HD] [WEB-DL] [Озвучка LostFilm]`,
        `magnet:?xt=urn:btih:b2c3d4e5f60718293a4b5c6d7e8f901234abcdef&dn=${encodeURIComponent(qStr)}+720p`,
        2.2 * 1024 * 1024 * 1024,
        98,
        4,
        'Rutor Tracker (Demo)'
      ),
    ];
  }
}
