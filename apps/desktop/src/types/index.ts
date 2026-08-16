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
  /** TMDB-коллекция (франшиза): предыдущая/следующая части по хронологии. */
  belongs_to_collection?: {
    id: number;
    name: string;
    poster_path: string | null;
    backdrop_path: string | null;
  } | null;
}

/** Актёр: страница с биографией и фильмографией (TMDB /person/{id}). */
export interface Person {
  id: number;
  name: string;
  biography: string;
  profile_path: string | null;
  birthday?: string;
  deathday?: string | null;
  place_of_birth?: string | null;
  also_known_as?: string[];
  /** Фильмография (combined_credits → cast), только фильмы. */
  credits?: PersonCredit[];
}

/** Запись фильмографии актёра: Movie + роль. */
export interface PersonCredit extends Movie {
  character?: string;
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

declare global {
  interface Window {
    electronAPI?: {
      getTorrServerStatus: () => Promise<TorrServerStatusInfo>;
      startTorrServer: () => Promise<TorrServerStatusInfo>;
      stopTorrServer: () => Promise<{ running: boolean }>;
      restartTorrServer: () => Promise<TorrServerStatusInfo>;
      configureTorrServer: (ramCacheMB: number) => Promise<any>;
      /** Push-подписка на изменения статуса TorrServer из Main Process. Возвращает unsubscribe. */
      onTorrServerStatusChanged: (callback: (status: TorrServerStatusInfo) => void) => () => void;
      addMagnetToTorrServer: (magnet: string, title?: string, poster?: string) => Promise<{ success: boolean; data?: any; error?: string }>;
      addTorrentFileToTorrServer: (base64: string, title?: string) => Promise<{ success: boolean; data?: any; error?: string }>;
      getTorrServerTorrent: (hash: string) => Promise<{ success: boolean; data?: any; error?: string }>;
      removeTorrServerTorrent: (hash: string) => Promise<{ success: boolean; data?: any; error?: string }>;
      dropTorrServerCache: (hash: string) => Promise<{ success: boolean }>;
      reconnectTorrServer: (hash: string, magnet: string) => Promise<{ success: boolean; error?: string }>;
      resetTorrServerNetwork: () => Promise<{ success: boolean; error?: string }>;
      onNetworkChanged: (callback: (data: { newIp: string }) => void) => () => void;
      getTorrServerLogs: (lines?: number) => Promise<{ success: boolean; logs: string[]; error?: string }>;
      getStreamUrl: (hash: string, fileIndex?: number, transcodeAudio?: boolean, audioIndex?: number) => Promise<string>;
      searchTorrents: (
        query: string,
        year?: string,
        jackettUrl?: string,
        jackettApiKey?: string,
        imdbId?: string,
        fallbackQuery?: string
      ) => Promise<{ success: boolean; releases: TorrentRelease[]; error?: string }>;
      openExternal: (url: string) => Promise<void>;
      getPlatformInfo: () => Promise<{ platform: string; arch: string }>;
      // Catalog Proxy
      catalogSearch: (query: string) => Promise<{ success: boolean; items: CatalogItem[]; error?: string }>;
      catalogGetPage: (category: string, page: number) => Promise<{ success: boolean; items: CatalogItem[]; page: number; hasMore: boolean; error?: string }>;
      catalogProxyImage: (imageUrl: string) => Promise<{ success: boolean; data?: string; contentType?: string }>;
      catalogGetPlaceholder: (title: string) => Promise<string>;
      // Image proxy — returns data-URI or null on failure
      fetchImage: (imageUrl: string) => Promise<string | null>;
      // Прямые онлайн-плееры HDRezka/Filmix
      findPlayers: (
        title: string,
        originalTitle: string,
        year: string
      ) => Promise<{ success: boolean; streams: OnlineStream[]; error?: string }>;
      // Открыть поток во внешнем плеере (VLC / IINA)
      openInExternalPlayer: (url: string) => Promise<{ success: boolean; app?: string }>;
      // Silent VK Auth: гостевая сессия (main) + поиск видео без CORS
      vkAcquireSession: () => Promise<{ success: boolean; error?: string }>;
      vkSearchVideo: (query: string) => Promise<{
        success: boolean;
        items: Array<{ ownerId: string; videoId: string; hash?: string; title?: string }>;
        error?: string;
      }>;
      // VK Video БЕЗ токена: публичный агрегатор → HLS (electron/vkScraper.ts)
      vkScrapeVideo: (query: string) => Promise<{
        success: boolean;
        items: Array<{
          ownerId: string;
          videoId: string;
          title?: string;
          duration?: number;
          hlsUrl?: string;
          mp4Url?: string;
        }>;
        error?: string;
      }>;
      // Локальный JacRed (Zero-Config: бинарник + spawn на 127.0.0.1:9117)
      getJacredStatus: () => Promise<{
        running: boolean;
        starting?: boolean;
        port: number;
        error?: string;
      }>;
      startJacredServer: () => Promise<{
        running: boolean;
        starting?: boolean;
        port: number;
        error?: string;
      }>;
      stopJacredServer: () => Promise<{ running: boolean; port: number }>;
      openJacredUi: () => Promise<{ success: boolean }>;
      /** Авторизация приватных трекеров в локальном JacRed (для плашки в настройках). */
      getJacredAuthStatus: () => Promise<{ rutracker: boolean; nnmClub: boolean }>;
      /** Сохранить креды приватного трекера в конфиг JacRed + разгон парсера. */
      jacredLogin: (
        tracker: 'rutracker' | 'nnmclub',
        creds: { username?: string; password?: string; cookie?: string }
      ) => Promise<{ success: boolean; auth?: { rutracker: boolean; nnmClub: boolean }; error?: string }>;
      // RuTracker: браузерный сеанс (вход в окне приложения + поиск через window.fetch)
      rutrackerGetStatus: () => Promise<{ loggedIn: boolean; loginWindowOpen: boolean; error?: string }>;
      rutrackerOpenLogin: () => Promise<{ loggedIn: boolean; loginWindowOpen: boolean; error?: string }>;
      rutrackerHideLogin: () => Promise<{ ok: boolean }>;
      rutrackerSearch: (query: string, year?: string, fallbackQuery?: string) => Promise<{ success: boolean; releases: TorrentRelease[]; error?: string }>;
      onRutrackerStatusChanged: (callback: (st: { loggedIn: boolean }) => void) => () => void;
      // Онлайн-потоки (KinoBox + Kodik): прямой .m3u8 без TorrServer
      searchOnlineStreams: (
        kinopoiskId?: number | string,
        tmdbId?: number | string,
        title?: string,
        year?: string,
        kodikToken?: string
      ) => Promise<{ success: boolean; streams: OnlineBalancerStream[]; error?: string }>;
      /** Referer для CDN активного онлайн-потока (сетевой перехватчик Electron). */
      setOnlineStreamReferer: (host: string, referer: string) => Promise<{ ok: boolean }>;
      clearOnlineStreamReferer: (host: string) => Promise<{ ok: boolean }>;
    };
  }
}
