import { CatalogItem, CatalogPage, Movie } from '../types';

/** Max items per page — pulled from proxy. */
const PAGE_SIZE = 30;

/**
 * Convert a CatalogItem (from HDRezka/Filmix) into a unified Movie
 * that the rest of the UI can consume.
 */
function catalogItemToMovie(item: CatalogItem): Movie {
  const rating = parseFloat(item.rating) || 6.0;
  const year = item.year || '';
  return {
    id: item.id as any,
    title: item.title,
    original_title: item.original_title || item.title,
    overview: item.description || '',
    poster_path: item.poster_url || null,
    backdrop_path: null,
    release_date: year ? `${year}-01-01` : undefined,
    vote_average: rating,
    genre_ids: [],
    media_type: item.type,
    source: item.source,
    url: item.url,
    quality: item.quality,
    season_count: item.season_count,
    episode_count: item.episode_count,
    year,
  };
}

/**
 * Catalog service backed by Electron IPC → HDRezka / Filmix.
 * Falls back to generated demo data when Electron bridge is unavailable.
 */
export class CatalogService {
  // ── Image helpers ──

  /** Convert original poster URL → luminary-img:// proxy URL */
  getImageUrl(posterUrl: string | null | undefined): string {
    if (!posterUrl) return '';
    // If it's already a data URI or proxy URL, return as-is
    if (posterUrl.startsWith('data:') || posterUrl.startsWith('luminary-img://')) {
      return posterUrl;
    }
    // Encode original URL as base64 for the protocol handler
    const encoded = Buffer.from(posterUrl).toString('base64');
    return `luminary-img://${encoded}`;
  }

  /** Get SVG placeholder for a film title. */
  async getPosterPlaceholder(title: string): Promise<string> {
    if (window.electronAPI?.catalogGetPlaceholder) {
      return await window.electronAPI.catalogGetPlaceholder(title);
    }
    // Fallback: inline SVG
    const safe = (title || 'Luminary').replace(/[<>&"\']/g, '').slice(0, 42);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750">
      <rect width="500" height="750" fill="#0a0a0d"/>
      <rect x="24" y="24" width="452" height="702" rx="28" fill="none" stroke="rgba(0,242,254,0.3)" stroke-width="2"/>
      <text x="50%" y="50%" text-anchor="middle" fill="rgba(240,242,248,0.7)" font-size="16" font-weight="700">${safe}</text>
    </svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  // ── Global Search ──

  async search(query: string): Promise<Movie[]> {
    if (!query.trim()) return [];
    const q = query.trim().slice(0, 200);

    if (window.electronAPI?.catalogSearch) {
      const res = await window.electronAPI.catalogSearch(q);
      if (res.success && res.items.length > 0) {
        return res.items.map(catalogItemToMovie);
      }
    }

    // Offline fallback — demo search
    return this.generateDemoSearch(q);
  }

  // ── Catalog Pages ──

  async getCatalogPage(category: string, page: number = 1): Promise<{ movies: Movie[]; hasMore: boolean; page: number }> {
    if (window.electronAPI?.catalogGetPage) {
      const res = await window.electronAPI.catalogGetPage(category, page);
      if (res.success && res.items.length > 0) {
        return {
          movies: res.items.map(catalogItemToMovie),
          hasMore: res.hasMore,
          page: res.page,
        };
      }
    }

    // Offline fallback
    return { movies: this.generateDemoCatalog(category), hasMore: false, page: 1 };
  }

  /** Fetch multiple pages and merge. */
  async getCatalogMultiPage(category: string, pages: number = 2): Promise<Movie[]> {
    const results: Movie[] = [];
    for (let p = 1; p <= pages; p++) {
      const { movies, hasMore } = await this.getCatalogPage(category, p);
      results.push(...movies);
      if (!hasMore) break;
    }
    return results.slice(0, PAGE_SIZE * pages);
  }

  // ── Convenience methods ──

  async getPopularMovies(): Promise<Movie[]> {
    return this.getCatalogMultiPage('popular_movies', 2);
  }

  async getNewMovies(): Promise<Movie[]> {
    return this.getCatalogMultiPage('new_movies', 2);
  }

  async getTrendingMovies(): Promise<Movie[]> {
    // "new" is closest to trending on HDRezka
    return this.getCatalogMultiPage('new_movies', 1);
  }

  async getTopRatedMovies(): Promise<Movie[]> {
    return this.getCatalogMultiPage('best_movies', 2);
  }

  async getNowPlayingMovies(): Promise<Movie[]> {
    return this.getCatalogMultiPage('new_movies', 2);
  }

  async getPopularTV(): Promise<Movie[]> {
    return this.getCatalogMultiPage('popular_series', 2);
  }

  async getNewSeries(): Promise<Movie[]> {
    return this.getCatalogMultiPage('new_series', 2);
  }

  async getAnimation(): Promise<Movie[]> {
    return this.getCatalogMultiPage('animation', 2);
  }

  async getMoviesByGenre(genre: string): Promise<Movie[]> {
    // HDRezka doesn't have genre API — search by genre name
    return this.search(genre);
  }

  async getMovieDetails(id: string): Promise<Movie | null> {
    // For HDRezka/Filmix items, we already have all the data
    // Use search to find if needed
    return null;
  }

  // ── Demo fallback catalog ──

  private generateDemoSearch(query: string): Movie[] {
    const all = this.generateDemoCatalog('all');
    const q = query.toLowerCase();
    return all.filter(
      (m) =>
        m.title.toLowerCase().includes(q) ||
        (m.original_title || '').toLowerCase().includes(q)
    );
  }

  private generateDemoCatalog(category: string): Movie[] {
    const base: Movie[] = [
      { id: 1, title: 'Джон Уик 4', original_title: 'John Wick: Chapter 4', overview: 'Джон Уик находит способ одержать победу над Правлением.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/5d9b7c1d-7e4e-4e5e-8a8a-1e8e7e6e5d4a/300x450', backdrop_path: null, release_date: '2023-01-01', vote_average: 8.1, media_type: 'movie', source: 'hdrezka', quality: '4K UHD', year: '2023' },
      { id: 2, title: 'Оппенгеймер', original_title: 'Oppenheimer', overview: 'История создания атомной бомбы.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/8a7b6c5d-4e3e-2d1c-0b9a-8f7e6d5c4b3a/300x450', backdrop_path: null, release_date: '2023-01-01', vote_average: 8.5, media_type: 'movie', source: 'hdrezka', quality: '1080p', year: '2023' },
      { id: 3, title: 'Барби', original_title: 'Barbie', overview: 'Барби и Кен отправляются в реальный мир.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/9c8d7e6f-5d4c-3b2a-1e0d-9c8b7a6f5e4d/300x450', backdrop_path: null, release_date: '2023-01-01', vote_average: 7.8, media_type: 'movie', source: 'hdrezka', quality: '1080p', year: '2023' },
      { id: 4, title: 'Стражи Галактики 3', original_title: 'Guardians of the Galaxy Vol. 3', overview: 'Финальное приключение Стражей.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/0d1e2f3c-4b5a-6978-8c9d-0e1f2a3b4c5d/300x450', backdrop_path: null, release_date: '2023-01-01', vote_average: 8.2, media_type: 'movie', source: 'hdrezka', quality: '4K HDR', year: '2023' },
      { id: 5, title: 'Человек-паук: Паутина вселенных', original_title: 'Spider-Man: Across the Spider-Verse', overview: 'Майлз Моралес путешествует по мультивселенной.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/1f2e3d4c-5b6a-7c8d-9e0f-1a2b3c4d5e6f/300x450', backdrop_path: null, release_date: '2023-01-01', vote_average: 8.7, media_type: 'movie', source: 'hdrezka', quality: '4K DV', year: '2023' },
      { id: 6, title: 'Миссия невыполнима 7', original_title: 'Mission: Impossible – Dead Reckoning', overview: 'Итан Хант против ИИ.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/2a3b4c5d-6e7f-8a9b-0c1d-2e3f4a5b6c7d/300x450', backdrop_path: null, release_date: '2023-01-01', vote_average: 8.0, media_type: 'movie', source: 'hdrezka', quality: '1080p', year: '2023' },
      { id: 7, title: 'Флэш', original_title: 'The Flash', overview: 'Барри Аллен меняет прошлое.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/3b4c5d6e-7f8a-9b0c-1d2e-3f4a5b6c7d8e/300x450', backdrop_path: null, release_date: '2023-01-01', vote_average: 7.5, media_type: 'movie', source: 'hdrezka', quality: '4K', year: '2023' },
      { id: 8, title: 'Аватар: Путь воды', original_title: 'Avatar: The Way of Water', overview: 'Джейк Салли возвращается на Пандору.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/4c5d6e7f-8a9b-0c1d-2e3f-4a5b6c7d8e9f/300x450', backdrop_path: null, release_date: '2022-01-01', vote_average: 8.1, media_type: 'movie', source: 'hdrezka', quality: '4K HDR', year: '2022' },
      { id: 9, title: 'Топ Ган: Мэверик', original_title: 'Top Gun: Maverick', overview: 'Пит Митчелл тренирует новое поколение.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/5d6e7f8a-9b0c-1d2e-3f4a-5b6c7d8e9f0a/300x450', backdrop_path: null, release_date: '2022-01-01', vote_average: 8.4, media_type: 'movie', source: 'hdrezka', quality: '4K', year: '2022' },
      { id: 10, title: 'Дюна: Часть вторая', original_title: 'Dune: Part Two', overview: 'Пол Атрейдес объединяется с фременами.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/6e7f8a9b-0c1d-2e3f-4a5b-6c7d8e9f0a1b/300x450', backdrop_path: null, release_date: '2024-01-01', vote_average: 8.6, media_type: 'movie', source: 'hdrezka', quality: '4K DV', year: '2024' },
      { id: 11, title: 'Одни из нас', original_title: 'The Last of Us', overview: 'Постапокалиптическая драма по мотивам игры.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/7f8a9b0c-1d2e-3f4a-5b6c-7d8e9f0a1b2c/300x450', backdrop_path: null, release_date: '2023-01-01', vote_average: 8.8, media_type: 'tv', source: 'hdrezka', quality: '1080p', year: '2023', season_count: 1, episode_count: 9 },
      { id: 12, title: 'Мандалорец', original_title: 'The Mandalorian', overview: 'Приключения одинокого охотника за головами.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/8a9b0c1d-2e3f-4a5b-6c7d-8e9f0a1b2c3d/300x450', backdrop_path: null, release_date: '2019-01-01', vote_average: 8.6, media_type: 'tv', source: 'hdrezka', quality: '4K DV', year: '2019', season_count: 3, episode_count: 24 },
      { id: 13, title: 'Дом Дракона', original_title: 'House of the Dragon', overview: 'Приквел Игры престолов о доме Таргариенов.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/9b0c1d2e-3f4a-5b6c-7d8e-9f0a1b2c3d4e/300x450', backdrop_path: null, release_date: '2022-01-01', vote_average: 8.4, media_type: 'tv', source: 'hdrezka', quality: '4K HDR', year: '2022', season_count: 2, episode_count: 18 },
      { id: 14, title: 'Рик и Морти', original_title: 'Rick and Morty', overview: 'Безумные приключения гениального учёного и его внука.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/0c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f/300x450', backdrop_path: null, release_date: '2013-01-01', vote_average: 9.0, media_type: 'tv', source: 'hdrezka', quality: '1080p', year: '2013', season_count: 7, episode_count: 71 },
      { id: 15, title: 'Очень странные дела', original_title: 'Stranger Things', overview: 'Дети сталкиваются со сверхъестественным в маленьком городе.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/1d2e3f4a-5b6c-7d8e-9f0a-1b2c3d4e5f6a/300x450', backdrop_path: null, release_date: '2016-01-01', vote_average: 8.7, media_type: 'tv', source: 'hdrezka', quality: '4K', year: '2016', season_count: 4, episode_count: 34 },
      { id: 16, title: 'Бэтмен', original_title: 'The Batman', overview: 'Бэтмен расследует серию убийств в Готэме.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/2e3f4a5b-6c7d-8e9f-0a1b-2c3d4e5f6a7b/300x450', backdrop_path: null, release_date: '2022-01-01', vote_average: 8.2, media_type: 'movie', source: 'hdrezka', quality: '4K HDR', year: '2022' },
      { id: 17, title: 'Всё везде и сразу', original_title: 'Everything Everywhere All at Once', overview: 'Женщина открывает параллельные вселенные.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/3f4a5b6c-7d8e-9f0a-1b2c-3d4e5f6a7b8c/300x450', backdrop_path: null, release_date: '2022-01-01', vote_average: 8.5, media_type: 'movie', source: 'hdrezka', quality: '4K', year: '2022' },
      { id: 18, title: 'Атака титанов', original_title: 'Shingeki no Kyojin', overview: 'Человечество борется с гигантскими титанами.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/4a5b6c7d-8e9f-0a1b-2c3d-4e5f6a7b8c9d/300x450', backdrop_path: null, release_date: '2013-01-01', vote_average: 9.1, media_type: 'tv', source: 'hdrezka', quality: '1080p', year: '2013', season_count: 4, episode_count: 87 },
      { id: 19, title: 'Интерстеллар', original_title: 'Interstellar', overview: 'Путешествие через червоточину.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/5b6c7d8e-9f0a-1b2c-3d4e-5f6a7b8c9d0e/300x450', backdrop_path: null, release_date: '2014-01-01', vote_average: 8.8, media_type: 'movie', source: 'hdrezka', quality: '4K HDR', year: '2014' },
      { id: 20, title: 'Джокер', original_title: 'Joker', overview: 'Происхождение культового злодея.', poster_path: 'https://avatars.mds.yandex.net/get-kinopoisk-image/6201401/6c7d8e9f-0a1b-2c3d-4e5f-6a7b8c9d0e1f/300x450', backdrop_path: null, release_date: '2019-01-01', vote_average: 8.6, media_type: 'movie', source: 'hdrezka', quality: '4K DV', year: '2019' },
    ];

    if (category === 'all') return base;

    // Filter by category
    const isTV = ['popular_series', 'new_series', 'best_series'].includes(category);
    let filtered = base.filter((m) => {
      if (isTV) return m.media_type === 'tv';
      if (category === 'animation') return m.genres?.some(g => g.name?.includes('мульт') || g.name?.includes('анимация'));
      return m.media_type === 'movie';
    });

    // Limit per category to avoid duplicates across rails
    if (filtered.length === 0) filtered = base.slice(0, PAGE_SIZE);
    return filtered.slice(0, PAGE_SIZE);
  }
}

export const catalogService = new CatalogService();
