import axios from 'axios';

export interface OnlineStream {
  source: 'kinobox' | 'kodik' | 'alloha';
  title: string;
  quality: string;
  url: string;        // Direct HLS/MP4 URL
  type: 'hls' | 'mp4';
  language: string;   // e.g. 'RU', 'EN', 'UK'
}

export interface OnlinePlayerResult {
  streams: OnlineStream[];
  source: string;
}

/**
 * Serverless online player lookup via public Kinobox / Kodik / Alloha APIs.
 * All requests go through Electron Main Process (if available) or direct
 * with CORS handled by webSecurity:false in BrowserWindow.
 */
export class OnlinePlayersService {
  private readonly KINOBOX_API = 'https://kinobox.tv/api';
  private readonly KODIK_API = 'https://kodikapi.com';
  private readonly ALLOHA_API = 'https://alloha.tv/api';

  /**
   * Search for direct HLS/MP4 streams across all providers.
   * Falls back gracefully to empty array if all sources are down.
   */
  async searchStreams(title: string, year?: string, kinopoiskId?: string): Promise<OnlinePlayerResult[]> {
    const results: OnlinePlayerResult[] = [];
    const searchTitle = year ? `${title} ${year}` : title;

    const providers: Array<{ name: string; run: () => Promise<OnlineStream[]> }> = [
      {
        name: 'Kinobox',
        run: () => this.queryKinobox(searchTitle, kinopoiskId),
      },
      {
        name: 'Kodik',
        run: () => this.queryKodik(searchTitle, kinopoiskId),
      },
      {
        name: 'Alloha',
        run: () => this.queryAlloha(searchTitle),
      },
    ];

    const settled = await Promise.allSettled(providers.map((p) => p.run()));

    settled.forEach((outcome, i) => {
      const name = providers[i].name;
      if (outcome.status === 'fulfilled' && outcome.value.length > 0) {
        results.push({ streams: outcome.value, source: name });
        console.log(`[OnlinePlayers] ${name}: ${outcome.value.length} streams`);
      } else {
        const reason = outcome.status === 'rejected' ? outcome.reason.message : 'empty';
        console.warn(`[OnlinePlayers] ${name}: ${reason}`);
      }
    });

    return results;
  }

  // ═══════════════════════════════════════════════
  //  Kinobox — free movie/series player API
  // ═══════════════════════════════════════════════
  private async queryKinobox(title: string, kinopoiskId?: string): Promise<OnlineStream[]> {
    try {
      const params: Record<string, string> = {
        title,
        ...(kinopoiskId ? { kp: kinopoiskId } : {}),
      };

      const response = await axios.get(`${this.KINOBOX_API}/players`, {
        params,
        timeout: 6000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
        validateStatus: (s) => s >= 200 && s < 300,
      });

      const data = response.data;
      const items = Array.isArray(data) ? data : data?.items || data?.results || [];

      return items
        .filter((item: any) => item?.url || item?.iframe_url || item?.link)
        .map((item: any) => ({
          source: 'kinobox' as const,
          title: item.title || title,
          quality: item.quality || item.resolution || 'HD',
          url: item.url || item.iframe_url || item.link || '',
          type: (item.url || '').includes('.m3u8') ? 'hls' : 'mp4',
          language: item.lang || item.language || 'RU',
        }));
    } catch (err: any) {
      console.warn('[OnlinePlayers] Kinobox:', err.message);
      return [];
    }
  }

  // ═══════════════════════════════════════════════
  //  Kodik — public video API (requires token)
  // ═══════════════════════════════════════════════
  private async queryKodik(title: string, kinopoiskId?: string): Promise<OnlineStream[]> {
    try {
      // Kodik public search (no token needed for basic search)
      const params: Record<string, string> = {
        title,
        ...(kinopoiskId ? { kinopoisk_id: kinopoiskId } : {}),
        limit: '5',
        with_episodes: 'false',
        with_seasons: 'false',
      };

      const response = await axios.get(`${this.KODIK_API}/search`, {
        params,
        timeout: 6000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
        validateStatus: (s) => s >= 200 && s < 300,
      });

      const data = response.data;
      const results = Array.isArray(data?.results) ? data.results : [];

      return results.map((item: any) => ({
        source: 'kodik' as const,
        title: item.title || title,
        quality: item.quality || 'HD',
        url: item.link || `https://kodik.info/video/${item.id}`,
        type: 'hls' as const,
        language: item.translation?.title || 'RU',
      }));
    } catch (err: any) {
      console.warn('[OnlinePlayers] Kodik:', err.message);
      return [];
    }
  }

  // ═══════════════════════════════════════════════
  //  Alloha — free online cinema API
  // ═══════════════════════════════════════════════
  private async queryAlloha(title: string): Promise<OnlineStream[]> {
    try {
      const response = await axios.get(`${this.ALLOHA_API}/search`, {
        params: { query: title, limit: 5 },
        timeout: 5000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
        validateStatus: (s) => s >= 200 && s < 300,
      });

      const data = response.data;
      const items = Array.isArray(data) ? data : data?.data || data?.results || [];

      return items.map((item: any) => ({
        source: 'alloha' as const,
        title: item.title || item.name || title,
        quality: item.quality || 'HD',
        url: item.player_url || item.url || `https://alloha.tv/player/${item.id}`,
        type: 'hls' as const,
        language: item.lang || 'RU',
      }));
    } catch (err: any) {
      console.warn('[OnlinePlayers] Alloha:', err.message);
      return [];
    }
  }
}

export const onlinePlayersService = new OnlinePlayersService();
