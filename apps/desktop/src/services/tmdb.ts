import axios from 'axios';
import { Movie } from '../types';

// Public read-only TMDB v3 key (Lampa-style). Users can override in Settings.
const DEFAULT_TMDB_KEY = '8265bd1679663a7ea12ac168da84d2e8';
const BASE_URL = 'https://api.themoviedb.org/3';
const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';
/** Minimum items per catalog rail after merging pages */
const MIN_CATALOG = 20;

export const TMDB_GENRES = {
  action: { id: 28, label: 'Боевики' },
  comedy: { id: 35, label: 'Комедии' },
  scifi: { id: 878, label: 'Фантастика' },
  thriller: { id: 53, label: 'Триллеры' },
  drama: { id: 18, label: 'Драмы' },
  animation: { id: 16, label: 'Анимация' },
} as const;

export class TMDBService {
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || DEFAULT_TMDB_KEY;
  }

  public setApiKey(key: string) {
    this.apiKey = key || DEFAULT_TMDB_KEY;
  }

  /** Shared locale params для RU-каталога (Lampa-style).
   *  ВАЖНО: `region` НЕ передаём — TMDB подменяет release_date на региональную
   *  дату проката/переиздания (например, Шоушенк в РФ: 2019-10-24 вместо 1994).
   *  Год должен биндиться строго из ОРИГИНАЛЬНОЙ мировой даты релиза. */
  private localeParams(extra: Record<string, string | number> = {}) {
    return {
      api_key: this.apiKey,
      language: 'ru-RU',
      include_adult: false,
      ...extra,
    };
  }

  public getImageUrl(
    path: string | null | undefined,
    size: 'w185' | 'w300' | 'w500' | 'w780' | 'w1280' | 'original' = 'w500'
  ): string {
    if (!path) return '';
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${IMAGE_BASE_URL}/${size}${normalized}`;
  }

  /** SVG data-URI poster with title — used when TMDB image 404s / missing path. */
  public getPosterPlaceholder(title: string): string {
    const safe = (title || 'Luminary')
      .replace(/[<>&"']/g, '')
      .slice(0, 42);
    const lines = safe.length > 22 ? [safe.slice(0, 22), safe.slice(22)] : [safe];
    const textSvg = lines
      .map(
        (line, i) =>
          `<text x="50%" y="${48 + i * 7}%" text-anchor="middle" fill="rgba(240,242,248,0.85)" font-family="Segoe UI, Arial, sans-serif" font-size="14" font-weight="700">${line}</text>`
      )
      .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0a0a0d"/>
          <stop offset="50%" stop-color="#12141c"/>
          <stop offset="100%" stop-color="#1a1030"/>
        </linearGradient>
      </defs>
      <rect width="500" height="750" fill="url(#g)"/>
      <rect x="24" y="24" width="452" height="702" rx="28" fill="none" stroke="rgba(0,242,254,0.25)" stroke-width="2"/>
      <circle cx="250" cy="280" r="48" fill="none" stroke="rgba(0,242,254,0.35)" stroke-width="2"/>
      <polygon points="240,255 240,305 280,280" fill="rgba(0,242,254,0.7)"/>
      ${textSvg}
      <text x="50%" y="92%" text-anchor="middle" fill="rgba(0,242,254,0.45)" font-family="Segoe UI, Arial, sans-serif" font-size="11" letter-spacing="3">LUMINARY</text>
    </svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  private dedupeMovies(list: Movie[]): Movie[] {
    const map = new Map<number | string, Movie>();
    for (const m of list) {
      if (m?.id != null && !map.has(m.id)) map.set(m.id, m);
    }
    return Array.from(map.values());
  }

  /** Fetch pages 1..N and ensure at least MIN_CATALOG items when available. */
  private async fetchPaged(
    path: string,
    pages: number = 2,
    extra: Record<string, string | number> = {},
    mediaType: 'movie' | 'tv' = 'movie'
  ): Promise<Movie[]> {
    try {
      const reqs = Array.from({ length: pages }, (_, i) =>
        axios.get(`${BASE_URL}${path}`, {
          params: this.localeParams({ page: i + 1, ...extra }),
          timeout: 8000,
        })
      );
      const responses = await Promise.allSettled(reqs);
      const merged: Movie[] = [];
      for (const r of responses) {
        if (r.status === 'fulfilled') {
          const results = r.value.data?.results;
          if (Array.isArray(results)) {
            merged.push(
              ...results.map((m: any) => ({
                ...m,
                title: m.title || m.name || 'Без названия',
                original_title: m.original_title || m.original_name,
                release_date: m.release_date || m.first_air_date,
                media_type: (m.media_type === 'tv' ? 'tv' : mediaType) as 'movie' | 'tv',
              }))
            );
          }
        }
      }
      const unique = this.dedupeMovies(merged);
      if (unique.length === 0) return this.getDemoCatalog();
      return unique.slice(0, Math.max(MIN_CATALOG, Math.min(unique.length, 40)));
    } catch (err) {
      console.warn(`[TMDB] ${path} failed:`, err);
      return this.getDemoCatalog();
    }
  }

  public async getPopularMovies(): Promise<Movie[]> {
    return this.fetchPaged('/movie/popular', 2);
  }

  /** TMDB-First: trending rails (популярные новинки и тренды). */
  public async getTrending(): Promise<Movie[]> {
    return this.getTrendingMovies();
  }

  public async getTrendingMovies(): Promise<Movie[]> {
    return this.fetchPaged('/trending/movie/week', 2);
  }

  public async getTopRatedMovies(): Promise<Movie[]> {
    // Классический топ «всех времён»: /movie/top_rated с language=ru отдаёт
    // региональную смесь с новинками текущего года. Используем discover
    // с сортировкой по рейтингу и минимальным числом голосов.
    return this.fetchPaged('/discover/movie', 2, {
      sort_by: 'vote_average.desc',
      'vote_count.gte': 300,
    });
  }

  /** Now playing / fresh HD releases in RU region. */
  public async getNowPlayingMovies(): Promise<Movie[]> {
    return this.fetchPaged('/movie/now_playing', 2);
  }

  public async getPopularTV(): Promise<Movie[]> {
    const list = await this.fetchPaged('/tv/popular', 2);
    return list.map((m) => ({
      ...m,
      title: m.title || m.name || 'Сериал',
      original_title: m.original_title || (m as any).original_name,
      release_date: m.release_date || m.first_air_date,
      media_type: 'tv' as const,
    }));
  }

  public async getMoviesByGenre(genreId: number): Promise<Movie[]> {
    return this.fetchPaged('/discover/movie', 2, {
      with_genres: genreId,
      sort_by: 'popularity.desc',
    });
  }

  public async searchMovies(query: string): Promise<Movie[]> {
    if (!query.trim()) return [];
    try {
      const [p1, p2] = await Promise.all([
        axios.get(`${BASE_URL}/search/multi`, {
          params: this.localeParams({ query, page: 1 }),
          timeout: 6000,
        }),
        axios.get(`${BASE_URL}/search/multi`, {
          params: this.localeParams({ query, page: 2 }),
          timeout: 6000,
        }),
      ]);
      const merged = [
        ...(p1.data?.results || []),
        ...(p2.data?.results || []),
      ].filter((m: any) => m.media_type === 'movie' || m.media_type === 'tv' || m.title || m.name);

      return this.dedupeMovies(
        merged.map((m: any) => ({
          ...m,
          title: m.title || m.name || query,
          original_title: m.original_title || m.original_name,
          release_date: m.release_date || m.first_air_date,
          media_type: m.media_type === 'tv' ? 'tv' : 'movie',
        }))
      ).slice(0, 40);
    } catch (err) {
      return this.getDemoCatalog().filter((m) =>
        m.title.toLowerCase().includes(query.toLowerCase())
      );
    }
  }

  public async getMovieDetails(id: number | string, mediaType: 'movie' | 'tv' = 'movie'): Promise<Movie | null> {
    try {
      const path = mediaType === 'tv' ? `/tv/${id}` : `/movie/${id}`;
      const res = await axios.get(`${BASE_URL}${path}`, {
        params: this.localeParams({ append_to_response: 'credits,images' }),
        timeout: 6000,
      });
      const data = res.data;
      return {
        ...data,
        title: data.title || data.name,
        original_title: data.original_title || data.original_name,
        release_date: data.release_date || data.first_air_date,
        media_type: mediaType,
        runtime: data.runtime,
        genres: data.genres,
        // Кадры (backdrops) из TMDB для галереи в модалке
        stills: (data.images?.backdrops || [])
          .slice(0, 8)
          .map((b: any) => b.file_path),
        cast: data.credits?.cast?.slice(0, 8).map((c: any) => ({
          id: c.id,
          name: c.name,
          character: c.character,
          profile_path: c.profile_path,
        })),
      };
    } catch (err) {
      console.warn(`[TMDB] getMovieDetails(${id}) failed:`, err);
      const found = this.getDemoCatalog().find((m) => m.id === id);
      return found || null;
    }
  }

  private getDemoCatalog(): Movie[] {
    // Expanded offline fallback (≥20) so UI never shows a 5-card rail
    const base: Array<Partial<Movie> & { id: number; title: string; original_title: string; poster_path: string; backdrop_path: string; release_date: string; vote_average: number; overview: string }> = [
      { id: 299536, title: 'Мстители: Война бесконечности', original_title: 'Avengers: Infinity War', overview: 'Мстители сражаются с Таносом.', poster_path: '/7WsyChLLEzFiDOVTGDRtq38dYn9.jpg', backdrop_path: '/mbfBhYOi7WdGGndUtqSRd69pBIn.jpg', release_date: '2018-04-25', vote_average: 8.3 },
      { id: 157336, title: 'Интерстеллар', original_title: 'Interstellar', overview: 'Путешествие через червоточину.', poster_path: '/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg', backdrop_path: '/xJHokMbljvjADYdit5f6xSuGoKd.jpg', release_date: '2014-11-05', vote_average: 8.4 },
      { id: 27205, title: 'Начало', original_title: 'Inception', overview: 'Внедрение идеи через сны.', poster_path: '/oYuLE1h2CVCdIFavahawTPrXyB7.jpg', backdrop_path: '/s3TBrRGB1iav7ySaFIm8L2YPyUd.jpg', release_date: '2010-07-15', vote_average: 8.3 },
      { id: 550, title: 'Бойцовский клуб', original_title: 'Fight Club', overview: 'Подпольный бойцовский клуб.', poster_path: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg', backdrop_path: '/hZkgoQY85WpWv2aDHRvG74GqjV2.jpg', release_date: '1999-10-15', vote_average: 8.4 },
      { id: 438631, title: 'Дюна', original_title: 'Dune', overview: 'Пол Атрейдес на Арракисе.', poster_path: '/d5NXSklXo0qyIYkgV94WAgMIckC.jpg', backdrop_path: '/ee1kgL1ly5iWYiqGjj3uiwfZ2v.jpg', release_date: '2021-09-15', vote_average: 7.8 },
      { id: 155, title: 'Тёмный рыцарь', original_title: 'The Dark Knight', overview: 'Бэтмен против Джокера.', poster_path: '/qJ2tW6WMUDux911r6m7haRef0WH.jpg', backdrop_path: '/hqkIcbrOHL86UncnHIsHVcVmzue.jpg', release_date: '2008-07-16', vote_average: 8.5 },
      { id: 680, title: 'Криминальное чтиво', original_title: 'Pulp Fiction', overview: 'Переплетённые истории Лос-Анджелеса.', poster_path: '/d5iIlFn5s0ImszYzBPb8JPIfbXD.jpg', backdrop_path: '/suaEOtk1N1sgg2MTM7oZd2cfVp3.jpg', release_date: '1994-09-10', vote_average: 8.5 },
      { id: 278, title: 'Побег из Шоушенка', original_title: 'The Shawshank Redemption', overview: 'Надежда за решёткой.', poster_path: '/q6y0Go1tsGEsmtFryDOJo3dEmny.jpg', backdrop_path: '/kXfqcdQKsToO0OUXHcrrNCHDBzO.jpg', release_date: '1994-09-23', vote_average: 8.7 },
      { id: 238, title: 'Крёстный отец', original_title: 'The Godfather', overview: 'Эпос о семье Корлеоне.', poster_path: '/3bhkrj58Vtu7enYsRolD1fZdja1.jpg', backdrop_path: '/tmU7GeKVybMWFButWEGl2M4GeiP.jpg', release_date: '1972-03-14', vote_average: 8.7 },
      { id: 424, title: 'Список Шиндлера', original_title: "Schindler's List", overview: 'История спасения в годы Холокоста.', poster_path: '/sF1U4EUQS8YHUYjNl3pMGNIQyr0.jpg', backdrop_path: '/loRmVz1h1a8yTqX2o1xZ3xZ3x.jpg', release_date: '1993-12-15', vote_average: 8.6 },
      { id: 122, title: 'Властелин колец: Возвращение короля', original_title: 'The Lord of the Rings: The Return of the King', overview: 'Финальная битва за Средиземье.', poster_path: '/rCzpDGLbOoPwLjy3OAm5NUPOTrC.jpg', backdrop_path: '/2u7zbn8EudG6kLlBzUYqP8RyFU4.jpg', release_date: '2003-12-01', vote_average: 8.5 },
      { id: 497, title: 'Зелёная миля', original_title: 'The Green Mile', overview: 'Чудо на каторге.', poster_path: '/velWPhVMQeQKcxggNEU8YmIo52R.jpg', backdrop_path: '/l6hQYS9prP5yiqpE4m5kU1m0x.jpg', release_date: '1999-12-10', vote_average: 8.5 },
      { id: 13, title: 'Форрест Гамп', original_title: 'Forrest Gump', overview: 'Жизнь как коробка конфет.', poster_path: '/arw2vcBveWOVZr6pxU9FsKgON1j.jpg', backdrop_path: '/qdIMWbEceM1k5YgK3g8xX.jpg', release_date: '1994-06-23', vote_average: 8.5 },
      { id: 429, title: 'Хороший, плохой, злой', original_title: 'Il buono, il brutto, il cattivo', overview: 'Классика спагетти-вестерна.', poster_path: '/bX2xnavhMYjWDoZp1VM6VnU1xwe.jpg', backdrop_path: '/x4biAVdPVCghBdeqcExSFvM7A.jpg', release_date: '1966-12-23', vote_average: 8.5 },
      { id: 372058, title: 'Твоё имя', original_title: '君の名は。', overview: 'Два подростка меняются телами.', poster_path: '/q719jXXEzOoYaps6babgKnTON9r.jpg', backdrop_path: '/7OMAfDJozRgGpTbP0.jpg', release_date: '2016-08-26', vote_average: 8.5 },
      { id: 496243, title: 'Паразиты', original_title: '기생충', overview: 'Классовая сатира Пуна.', poster_path: '/7IiTtgloNAP3wQuoU4kN3XCY0Rq.jpg', backdrop_path: '/TU9NcgOw78.jpg', release_date: '2019-05-30', vote_average: 8.5 },
      { id: 11216, title: 'Cinema Paradiso', original_title: 'Nuovo Cinema Paradiso', overview: 'Любовь к кино в сицилийском городке.', poster_path: '/8SRUfRUi6x4O68n0VCbDNRa6iGL.jpg', backdrop_path: '/g4yJThc5x.jpg', release_date: '1988-11-17', vote_average: 8.4 },
      { id: 637, title: 'Жизнь прекрасна', original_title: "La vita è bella", overview: 'Отец защищает сына юмором.', poster_path: '/mfnkFewX0fInAkZZ91OT+dnh.jpg', backdrop_path: '/bORe0eI.jpg', release_date: '1997-12-20', vote_average: 8.4 },
      { id: 324857, title: 'Человек-паук: Через вселенные', original_title: 'Spider-Man: Into the Spider-Verse', overview: 'Майлз Моралес становится героем.', poster_path: '/iiZZdoQBEYBv6id8su7ImL0oCbD.jpg', backdrop_path: '/7d6EY.jpg', release_date: '2018-12-06', vote_average: 8.4 },
      { id: 19404, title: 'Несколько больше', original_title: 'दिलवाले दुल्हनिया ले जायेंगे', overview: 'Романтическая классика Болливуда.', poster_path: '/2CAL2433ZeIihfX1Hb2139CX0pW.jpg', backdrop_path: '/90ez6.jpg', release_date: '1995-10-20', vote_average: 8.5 },
      { id: 475557, title: 'Джокер', original_title: 'Joker', overview: 'Происхождение клоуна-преступника.', poster_path: '/udDclJoHjfjb8Ekgsd4FDteOkCU.jpg', backdrop_path: '/f5F4c.jpg', release_date: '2019-10-02', vote_average: 8.2 },
      { id: 603, title: 'Матрица', original_title: 'The Matrix', overview: 'Симуляция реальности.', poster_path: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg', backdrop_path: '/icmm.jpg', release_date: '1999-03-30', vote_average: 8.2 },
    ];
    return base.map((m) => ({ ...m, media_type: 'movie' as const }));
  }
}

export const tmdbService = new TMDBService();
