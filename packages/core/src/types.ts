export interface Movie {
  id: number | string;
  title: string;
  original_title?: string;
  name?: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  vote_count?: number;
  genre_ids?: number[];
  genres?: { id: number; name: string }[];
  runtime?: number;
  media_type?: 'movie' | 'tv';
  cast?: { id: number; name: string; character: string; profile_path: string | null }[];
  /** TMDB backdrops (кадры) для галереи в деталях */
  stills?: string[];
  // HDRezka / Filmix fields
  source?: 'hdrezka' | 'filmix' | 'tmdb';
  url?: string;
  quality?: string;
  season_count?: number;
  episode_count?: number;
  year?: string;
}

/** Прямой онлайн-плеер с HDRezka / Filmix (для блока «Смотреть») */
export interface OnlineStream {
  id: string;
  source: 'hdrezka' | 'filmix';
  dubbing: string;     // Озвучка: Дубляж, RHS, Оригинал и т.д.
  url: string;         // iframe-URL плеера
  type?: 'movie' | 'tv';
}

/** Бесплатный онлайн-поток (CDNvideohub / Collaps / Kodik) — прямая альтернатива торрентам. */
export interface OnlineBalancerStream {
  id: string;
  /** Название балансера: CDNvideohub, Collaps, Kodik… */
  source: string;
  /** Нормализованное качество: 4K / 1080p / 720p / SD. */
  quality: string;
  /** Перевод / озвучка: Дубляж, RHS, LostFilm, Оригинал… */
  translation: string;
  /** Прямой HLS-манифест (.m3u8) — уходит в Hls.js без TorrServer. */
  m3u8Url?: string;
  /** iframe-ссылка плеера балансера (fallback: внешний плеер). */
  iframeUrl?: string;
  /** Origin для заголовка Referer при воспроизведении (CDN балансеров). */
  referer?: string;
  /** Сериал ли это (для пикера серий). */
  isSerial?: boolean;
}

/** Unified catalog item from HDRezka / Filmix */
export interface CatalogItem {
  id: string;
  source: 'hdrezka' | 'filmix';
  title: string;
  original_title: string;
  year: string;
  type: 'movie' | 'tv';
  poster_url: string;
  rating: string;
  genres: string[];
  description: string;
  url: string;
  quality?: string;
  season_count?: number;
  episode_count?: number;
}

export interface CatalogPage {
  items: CatalogItem[];
  page: number;
  hasMore: boolean;
  totalPages?: number;
}

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

export interface TorrServerStatusInfo {
  running: boolean;
  port: number;
  version?: string;
  error?: string;
  /** Сервис в процессе запуска (UI: «Запуск сервиса...»). */
  starting?: boolean;
  /** Последние строки лога при ошибке старта — для плашки в UI. */
  errorLog?: string;
}

export interface TorrServerStats {
  hash: string;
  title: string;
  poster?: string;
  stat: number;
  stat_string: string;
  torrent_size: number;
  loaded_size: number;
  download_speed: number;
  upload_speed: number;
  active_peers: number;
  total_peers: number;
  file_stats?: Array<{
    id: number;
    path: string;
    length: number;
  }>;
}

export interface UserSettings {
  tmdbApiKey: string;
  torrServerPort: number;
  ramCacheMB: 256 | 512 | 1024 | 2048;
  preBufferMB: number;
  jackettUrl: string;
  jackettApiKey: string;
  /** VK User Access Token / session cookie для api.vk.com/method/video.search */
  vkToken: string;
  /** Пользовательский JacRed-инстанс (base URL) — RuTracker/NNM/Rutor через JacRed */
  jacredUrl: string;
  /** Kodik API-токен (опционально) — онлайн-потоки для аниме/сериалов. */
  kodikToken: string;
  autoStartTorrServer: boolean;
  autoCleanCacheOnClose: boolean;
  transcodeAudioToAac: boolean;
  /** TV-режим (управление пультом, D-pad) — тумблер в настройках; пусто = авто (UA). */
  tvMode?: boolean;
}
