import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { X, Star, Calendar, Clock, User, AlertTriangle, Play, Video, Heart, Bookmark, Tv, Radio, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { library, LibraryItem, formatClock } from '../services/library';
import { extractYear } from '../utils/year';
import { parseTorrentMeta } from '../utils/torrentMeta';
import { Movie, TorrentRelease, OnlineBalancerStream } from '../types';
import { tmdbService } from '../services/tmdb';
import { torrServerService } from '../services/torrserver';
import { mergeReleasesByHash } from '../services/scrapers/jacred';
import { toastBus } from '../services/toast';
import { searchVkVideo, VkVideoItem } from '../services/vkVideoService';
import { searchOnlineStreams } from '../services/onlineBalancers';
import { TorrentSelector } from './TorrentSelector';
import { EpisodeResumeDialog } from './EpisodeResumeDialog';

interface MovieDetailsModalProps {
  movie: Movie;
  onClose: () => void;
  /** Открыть окно настроек (для получения VK-токена). */
  onOpenSettings?: () => void;
  onPlayTorrent: (torrent: {
    magnet: string;
    title: string;
    poster?: string;
    videoCodec?: string;
    audioCodec?: string;
    /** Прямой HLS/MP4 поток (VK Video / онлайн-балансеры) — плеер играет без TorrServer. */
    directUrl?: string;
    directQuality?: string;
    /** Referer для CDN прямого потока (онлайн-балансеры: kinobox/alloha…). */
    directReferer?: string;
    /** .torrent-файл (base64, rutracker) — в TorrServer вместо магнета. */
    torrentFile?: string;
    /** Сезон/серия (для сериалов) — история ведётся по эпизодам. */
    season?: number;
    episode?: number;
    /** Явный таймкод возобновления (из умного меню серий). */
    startPosition?: number;
  }) => void;
}

export const MovieDetailsModal: React.FC<MovieDetailsModalProps> = ({
  movie,
  onClose,
  onOpenSettings,
  onPlayTorrent,
}) => {
  const [details, setDetails] = useState<Movie | null>(null);
  const [isFav, setIsFav] = useState(() => library.isFavorite(String(movie.id)));
  const [isLater, setIsLater] = useState(() => library.isInLater(String(movie.id)));

  const libItem = (): Omit<LibraryItem, 'updatedAt'> => ({
    id: String(movie.id),
    title: movie.title || movie.name || 'Без названия',
    poster: movie.poster_path,
    year: movie.year || (movie.release_date || '').slice(0, 4),
    mediaType: movie.media_type || 'movie',
  });

  const toggleFav = () => { setIsFav(library.toggleFavorite(libItem())); };
  const toggleLater = () => { setIsLater(library.toggleLater(libItem())); };
  const [releases, setReleases] = useState<TorrentRelease[]>([]);
  const [vkItems, setVkItems] = useState<VkVideoItem[]>([]);
  /** Онлайн-потоки (KinoBox/Kodik) — бесплатная альтернатива торрентам. */
  const [onlineStreams, setOnlineStreams] = useState<OnlineBalancerStream[]>([]);
  const [isSearchingOnline, setIsSearchingOnline] = useState(true);
  /** Секция «Онлайн» свёрнута/развёрнута (переключатель). */
  const [isOnlineOpen, setIsOnlineOpen] = useState(true);
  const [isScraping, setIsScraping] = useState(true);
  /** Фоновый поиск RuTracker ещё идёт (раздачи приедут позже, реактивно). */
  const [isRutrackerSearching, setIsRutrackerSearching] = useState(false);
  const [isSearchingVk, setIsSearchingVk] = useState(true);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** История просмотра (сериалы: сезон/серия + процент) — для умного меню запуска. */
  const [histItems, setHistItems] = useState<LibraryItem[]>([]);
  /** Умное меню запуска серии (диалог продолжения / пикер серий). */
  const [episodeUi, setEpisodeUi] = useState<{
    release: TorrentRelease;
    historyItem?: LibraryItem;
    initialView: 'dialog' | 'picker';
  } | null>(null);

  // TMDB-First: прямые постеры с CDN
  const backdropUrl = tmdbService.getImageUrl(movie.backdrop_path, 'w1280');
  const posterUrl   = tmdbService.getImageUrl(movie.poster_path, 'w500');

  // Год — строго из оригинальной даты релиза (release_date / first_air_date),
  // movie.year (год раздачи HDRezka/Filmix, ремастер 4K) — только как fallback.
  const year = extractYear(movie.release_date || movie.first_air_date) || extractYear(movie.year) || '';

  /** Сколько сезонов в сериале: TMDB (details.seasons) + максимум из раздач. */
  const tvSeasons = useMemo(() => {
    if (movie.media_type !== 'tv') return 0;
    let max = 0;
    const tmdbSeasons = (details as any)?.seasons;
    if (Array.isArray(tmdbSeasons)) {
      for (const s of tmdbSeasons) {
        const n = Number(s?.season_number);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    for (const r of releases) {
      const meta = parseTorrentMeta(r.title);
      if (meta.seasons != null && meta.seasons > max) max = meta.seasons;
    }
    return max;
  }, [movie, details, releases]);

  /** Счётчик «Повторить поиск» — инкремент перезапускает поиск раздач. */
  const [searchNonce, setSearchNonce] = useState(0);
  /** Фильтр сезона для сериалов (0 = все). Смена сезона переищет RuTracker. */
  const [seasonFilter, setSeasonFilter] = useState(0);
  /** Модалка ещё смонтирована (guard для фоновых ответов поиска). */
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    // TMDB-First: мгновенно показываем данные из карточки, фоном обогащаем деталями
    setDetails(movie);
    setIsScraping(true);
    setIsSearchingVk(true);
    setIsSearchingOnline(true);
    setOnlineStreams([]);
    setSearchError(null);
    setHistItems(library.getHistory()); // история (сезон/серия, прогресс) для умного меню
    setEpisodeUi(null);

    // Lampa-style dual-language search:
    // 1. Primary: Russian title + year → finds more RU-dubbed releases on Rutor/JacRed
    // 2. Fallback: original_title + year → if no RU results
    const primaryQuery = movie.title || movie.original_title || '';
    const fallbackQuery =
      movie.original_title && movie.original_title !== movie.title
        ? movie.original_title
        : undefined;

    let cancelled = false;
    const mediaType = movie.media_type || 'movie';
    const id = movie.id;

    // ── Обогащение из TMDB (описание, актеры, кадры) — фоном, не блокирует UI ──
    if (typeof id === 'number') {
      tmdbService
        .getMovieDetails(id, mediaType)
        .then((enriched) => {
          if (!cancelled && enriched) setDetails({ ...movie, ...enriched });
        })
        .catch(() => { /* карточка уже на экране — не критично */ });
    }

    // ── 1) VK Video: прямые HLS-потоки (Lampa-style, без TorrServer) ──
    searchVkVideo(`${primaryQuery}${year ? ' ' + year : ''}`.trim())
      .then((items) => {
        if (cancelled) return;
        setVkItems(items);
      })
      .catch((err: any) => {
        if (cancelled) return;
        console.warn('[MovieDetailsModal] VK Video search failed:', err?.message || err);
      })
      .finally(() => {
        if (!cancelled) setIsSearchingVk(false);
      });

    // ── 1b) Онлайн-потоки (KinoBox по KP-ID / Kodik по TMDB-ID) — параллельно
    //       с торрентами, не блокирует список. Торренты остаются главным
    //       источником: онлайн-список просто появляется ниже при наличии. ──
    searchOnlineStreams({
      // KinoBox принимает Кинопоиск-ID; в каталоге TMDB его нет, поэтому
      // KinoBox используется при наличии внешнего KP-ID, Kodik — по TMDB-ID
      // (movie.id) или названию+году (аниме/сериалы).
      kinopoiskId: undefined,
      tmdbId: typeof movie.id === 'number' ? movie.id : Number(movie.id) || undefined,
      title: primaryQuery,
      year,
    })
      .then((items) => {
        if (cancelled) return;
        setOnlineStreams(items);
      })
      .catch((err: any) => {
        if (cancelled) return;
        console.warn('[MovieDetailsModal] Online streams search failed:', err?.message || err);
      })
      .finally(() => {
        if (!cancelled) setIsSearchingOnline(false);
      });

    // ── 2) Торренты через TorrServer / JacRed (on-demand) ──
    torrServerService
      .searchTorrents(primaryQuery, year, undefined, undefined, undefined, fallbackQuery)
      .then(({ releases, error }) => {
        if (cancelled) return;
        setReleases(releases);
        setSearchError(error || null);
        setIsScraping(false);
        if (error) {
          toastBus.push(error, 'error');
        }
      })
      .catch((err: any) => {
        if (cancelled) return;
        console.error('[MovieDetailsModal] Torrent search failed:', err);
        setReleases([]);
        const msg = 'Не удалось выполнить поиск торрентов. Запустите TorrServer или проверьте соединение.';
        setSearchError(msg);
        setIsScraping(false);
        toastBus.push(msg, 'error');
      });

    // ── 3) RuTracker (браузерная сессия) — фоном, обычно 6-15с. ──
    // Не блокирует список: раздачи мёржатся реактивно, когда готовы —
    // раньше этот путь обрезался дедлайном 8с и раздачи «пропадали».
    setIsRutrackerSearching(true);
    torrServerService
      .searchRutrackerLate(primaryQuery, year, fallbackQuery)
      .then(({ releases: late }) => {
        if (cancelled) return;
        if (late.length > 0) {
          console.log(`[MovieDetailsModal] RuTracker догрузил ${late.length} раздач — мёржаем`);
          setReleases((prev) => mergeReleasesByHash(prev, late));
          setIsScraping(false);
        }
      })
      .catch((err: any) => {
        if (cancelled) return;
        console.warn('[MovieDetailsModal] RuTracker late search failed:', err?.message || err);
      })
      .finally(() => {
        if (!cancelled) setIsRutrackerSearching(false);
      });

    // ── Safety: жёсткий сброс скелетона через 8 с, даже если сервис завис ──
    const skeletonTimer = setTimeout(() => {
      if (!cancelled) setIsScraping(false);
    }, 8000);

    return () => {
      cancelled = true;
      clearTimeout(skeletonTimer);
    };
  }, [movie, searchNonce]);

  /** Воспроизвести раздачу (с опциональным сезоном/серией/таймкодом). */
  const playRelease = useCallback((
    release: TorrentRelease,
    opts?: { season?: number; episode?: number; startPosition?: number }
  ) => {
    onPlayTorrent({
      magnet: release.magnet,
      title: `${movie.title} (${release.quality})`,
      poster: posterUrl,
      // .torrent-файл (rutracker) — надёжнее магнета для TorrServer
      torrentFile: release.torrentFile,
      // Кодеки раздачи — плеер решает: играть или предложить VLC/IINA
      videoCodec: release.videoCodec,
      audioCodec: release.audioCodec,
      season: opts?.season,
      episode: opts?.episode,
      startPosition: opts?.startPosition,
    });
  }, [movie, onPlayTorrent, posterUrl]);

  /**
   * Клик по раздаче СЕРИАЛА: если в истории есть прогресс эпизодов — показываем
   * умное меню запуска (Продолжить / Следующая серия / Выбрать серию) вместо
   * немедленного воспроизведения. Фильмы играются сразу.
   */
  const handlePlayRelease = useCallback((
    release: TorrentRelease,
    opts?: { season?: number; episode?: number; startPosition?: number }
  ) => {
    if (movie.media_type === 'tv' && !opts) {
      const meta = parseTorrentMeta(release.title);
      const latest = histItems.find(
        (h) => h.id === String(movie.id) && h.season != null && h.episode != null
      );
      if (latest) {
        setEpisodeUi({ release, historyItem: latest, initialView: 'dialog' });
        return;
      }
      // История без эпизодов, но раздачи с S/E — сразу открываем пикер серий
      if (meta.seasons != null || meta.episodes != null) {
        setEpisodeUi({ release, historyItem: undefined, initialView: 'picker' });
        return;
      }
    }
    playRelease(release, opts);
  }, [movie, histItems, playRelease]);

  /** Воспроизвести VK-поток в нативном плеере Luminary (Hls.js, без TorrServer). */
  const handlePlayVk = (item: VkVideoItem) => {
    const url = item.hlsUrl || item.mp4Url;
    if (!url) {
      toastBus.push('У этого VK-видео не удалось получить поток', 'error');
      return;
    }
    onPlayTorrent({
      magnet: '',
      title: `${movie.title} [VK ${item.quality}]`,
      poster: posterUrl,
      directUrl: url,
      directQuality: item.quality,
    });
  };

  /**
   * Воспроизвести онлайн-поток балансера: прямой .m3u8 уходит в Hls.js
   * (с Referer CDN балансера). Без .m3u8 — открываем iframe-плеер в браузере.
   */
  const handlePlayOnline = (stream: OnlineBalancerStream) => {
    if (stream.m3u8Url) {
      onPlayTorrent({
        magnet: '',
        title: `${movie.title} [${stream.source} ${stream.quality}]`,
        poster: posterUrl,
        directUrl: stream.m3u8Url,
        directQuality: stream.quality,
        directReferer: stream.referer || 'https://kinobox.tv/',
      });
      return;
    }
    if (stream.iframeUrl) {
      window.electronAPI?.openExternal?.(stream.iframeUrl);
      return;
    }
    toastBus.push('У этого потока не удалось получить ссылку воспроизведения', 'error');
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        background: 'rgba(0,0,0,0.9)',
        animation: 'fadeIn 0.2s ease',
        overflowY: 'auto',
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '900px',
          background: 'rgba(11,12,17,0.985)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '28px',
          overflow: 'hidden',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 32px 80px rgba(0,0,0,0.9), 0 8px 24px rgba(0,0,0,0.6)',
          animation: 'scaleIn 0.3s cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: '1rem',
            right: '1rem',
            zIndex: 20,
            width: '38px',
            height: '38px',
            borderRadius: '50%',
            background: 'rgba(10,11,14,0.9)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,84,112,0.8)';
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,84,112,0.4)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(10,11,14,0.8)';
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.1)';
          }}
        >
          <X size={16} />
        </button>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {/* ── Hero Backdrop ── */}
          <div style={{ position: 'relative', height: '320px', flexShrink: 0 }}>
            <img
              src={backdropUrl}
              alt={movie.title}
              style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top' }}
            />
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(11,12,17,1) 0%, rgba(11,12,17,0.7) 40%, rgba(11,12,17,0.2) 100%)' }} />
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to right, rgba(11,12,17,0.7) 0%, transparent 50%)' }} />

            {/* Neon top shimmer line */}
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '2px', background: 'linear-gradient(90deg, transparent, rgba(0,242,254,0.5), rgba(138,43,226,0.5), transparent)' }} />

            {/* Hero Meta (Overlaid on backdrop) */}
            <div style={{ position: 'absolute', bottom: '1.5rem', left: '1.8rem', right: '1.8rem', display: 'flex', alignItems: 'flex-end', gap: '1.5rem' }}>
              {/* Poster */}
              <img
                src={posterUrl}
                alt={movie.title}
                style={{
                  width: '110px',
                  aspectRatio: '2/3',
                  objectFit: 'cover',
                  borderRadius: '14px',
                  border: '2px solid rgba(255,255,255,0.1)',
                  boxShadow: '0 8px 30px rgba(0,0,0,0.8), 0 0 20px rgba(0,242,254,0.08)',
                  flexShrink: 0,
                  display: 'none',
                }}
                onLoad={e => { (e.currentTarget as HTMLImageElement).style.display = 'block'; }}
              />

              {/* Text Meta */}
              <div style={{ flex: 1 }}>
                {/* Badges */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem', flexWrap: 'wrap' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '3px', padding: '3px 9px', borderRadius: '999px', background: 'rgba(255,184,0,0.15)', border: '1px solid rgba(255,184,0,0.4)', color: '#FFB800', fontSize: '0.75rem', fontWeight: 800, boxShadow: '0 0 10px rgba(255,184,0,0.2)' }}>
                    <Star size={11} fill="#FFB800" />
                    {movie.vote_average?.toFixed(1) || '8.0'}
                  </span>
                  {year && <span style={{ padding: '3px 9px', borderRadius: '999px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(240,242,248,0.65)', fontSize: '0.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '3px' }}><Calendar size={11}/>{year}</span>}
                  {details?.runtime && <span style={{ padding: '3px 9px', borderRadius: '999px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(240,242,248,0.65)', fontSize: '0.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '3px' }}><Clock size={11}/>{details.runtime} мин</span>}
                </div>

                {/* Library actions */}
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.6rem' }}>
                  <button
                    onClick={toggleFav}
                    title={isFav ? 'Убрать из избранного' : 'В избранное'}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.4rem 0.85rem',
                      borderRadius: '999px',
                      border: `1px solid ${isFav ? 'rgba(255,84,112,0.5)' : 'rgba(255,255,255,0.14)'}`,
                      background: isFav ? 'rgba(255,84,112,0.15)' : 'rgba(255,255,255,0.05)',
                      color: isFav ? '#FF5470' : 'rgba(240,242,248,0.7)',
                      fontSize: '0.74rem',
                      fontWeight: 700,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <Heart size={13} fill={isFav ? '#FF5470' : 'none'} />
                    {isFav ? 'В избранном' : 'Избранное'}
                  </button>
                  <button
                    onClick={toggleLater}
                    title={isLater ? 'Убрать из «Посмотреть позже»' : 'В «Посмотреть позже»'}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.4rem 0.85rem',
                      borderRadius: '999px',
                      border: `1px solid ${isLater ? 'rgba(0,242,254,0.5)' : 'rgba(255,255,255,0.14)'}`,
                      background: isLater ? 'rgba(0,242,254,0.12)' : 'rgba(255,255,255,0.05)',
                      color: isLater ? '#00F2FE' : 'rgba(240,242,248,0.7)',
                      fontSize: '0.74rem',
                      fontWeight: 700,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <Bookmark size={13} fill={isLater ? '#00F2FE' : 'none'} />
                    {isLater ? 'В списке' : 'Позже'}
                  </button>
                </div>

                {/* Title */}
                <h1 style={{ fontSize: 'clamp(1.4rem, 3vw, 2.2rem)', fontWeight: 900, color: '#fff', letterSpacing: '-0.02em', lineHeight: 1.1, marginBottom: '0.3rem', textShadow: '0 2px 12px rgba(0,0,0,0.8)' }}>
                  {movie.title || movie.name}
                </h1>

                {movie.original_title && movie.original_title !== movie.title && (
                  <p style={{ fontSize: '0.82rem', color: 'rgba(0,242,254,0.5)', fontWeight: 600 }}>{movie.original_title}</p>
                )}
              </div>
            </div>
          </div>

          {/* ── Content Body ── */}
          <div style={{ padding: '1.5rem 1.8rem 2rem' }}>
            {/* Overview */}
            <div style={{ marginBottom: '1.5rem' }}>
              <div style={{ fontSize: '0.68rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(0,242,254,0.55)', marginBottom: '0.6rem' }}>
                Сюжет
              </div>
              <p style={{ fontSize: '0.9rem', color: 'rgba(240,242,248,0.68)', lineHeight: 1.65 }}>
                {movie.overview || details?.overview || 'Описание недоступно.'}
              </p>
            </div>

            {/* ── Кадры (TMDB backdrops) ── */}
            {details?.stills && details.stills.length > 0 && (
              <div style={{ marginBottom: '1.5rem' }}>
                <div style={{ fontSize: '0.68rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(240,242,248,0.3)', marginBottom: '0.7rem' }}>
                  Кадры из фильма
                </div>
                <div style={{ display: 'flex', gap: '0.6rem', overflowX: 'auto', paddingBottom: '0.4rem' }} className="scrollbar-none">
                  {details.stills.map((still) => (
                    <img
                      key={still}
                      src={tmdbService.getImageUrl(still, 'w780')}
                      alt="Кадр"
                      loading="lazy"
                      style={{
                        width: '200px',
                        aspectRatio: '16/9',
                        objectFit: 'cover',
                        borderRadius: '12px',
                        border: '1px solid rgba(255,255,255,0.08)',
                        flexShrink: 0,
                        background: '#121318',
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* ── Cast ── */}
            {details?.cast && details.cast.length > 0 && (
              <div style={{ marginBottom: '1rem' }}>
                <div style={{ fontSize: '0.68rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(240,242,248,0.3)', marginBottom: '0.7rem' }}>
                  В главных ролях
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto', paddingBottom: '0.3rem' }} className="scrollbar-none">
                  {details.cast.map(actor => (
                    <div
                      key={actor.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        padding: '0.45rem 0.75rem 0.45rem 0.45rem',
                        borderRadius: '999px',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.07)',
                        flexShrink: 0,
                        transition: 'all 0.2s ease',
                        cursor: 'default',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLDivElement).style.background = 'rgba(0,242,254,0.06)';
                        (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(0,242,254,0.2)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.04)';
                        (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.07)';
                      }}
                    >
                      {actor.profile_path ? (
                        <img
                          src={tmdbService.getImageUrl(actor.profile_path, 'w185')}
                          alt={actor.name}
                          style={{ width: '26px', height: '26px', borderRadius: '50%', objectFit: 'cover', border: '1px solid rgba(0,242,254,0.2)' }}
                        />
                      ) : (
                        <div style={{ width: '26px', height: '26px', borderRadius: '50%', background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <User size={12} style={{ color: 'var(--text-muted)' }} />
                        </div>
                      )}
                      <div>
                        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{actor.name}</div>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{actor.character}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Онлайн / VK Video: прямые HLS-потоки (без TorrServer) ── */}
            <div
              style={{
                marginBottom: '1rem',
                background: 'rgba(14,15,21,0.93)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: '22px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: '1.2rem 1.4rem 1rem',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.65rem',
                }}
              >
                <div
                  style={{
                    width: '34px',
                    height: '34px',
                    borderRadius: '10px',
                    background: 'linear-gradient(135deg, rgba(0,198,251,0.2), rgba(16,245,172,0.15))',
                    border: '1px solid rgba(0,242,254,0.25)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 0 12px rgba(0,242,254,0.15)',
                    flexShrink: 0,
                  }}
                >
                  <Video size={16} style={{ color: 'var(--cyan)' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                    Онлайн / VK Video
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                    Прямые HLS-потоки из VK · без TorrServer
                  </div>
                </div>
                {vkItems.length > 0 && (
                  <span
                    style={{
                      padding: '2px 8px',
                      borderRadius: '999px',
                      background: 'rgba(0,242,254,0.12)',
                      border: '1px solid rgba(0,242,254,0.3)',
                      color: 'var(--cyan)',
                      fontSize: '0.7rem',
                      fontWeight: 800,
                      flexShrink: 0,
                    }}
                  >
                    {vkItems.length}
                  </span>
                )}
              </div>
              <div style={{ padding: '0.8rem 1.4rem 1.1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {isSearchingVk ? (
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {[1, 2, 3].map((n) => (
                      <div key={n} className="skeleton" style={{ width: '140px', height: '40px', borderRadius: '10px' }} />
                    ))}
                  </div>
                ) : vkItems.length === 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    <Video size={14} />
                    VK-потоки не найдены — используйте торренты ниже
                  </div>
                ) : (
                  vkItems.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => handlePlayVk(item)}
                      title={`Воспроизвести в плеере Luminary: ${item.title}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.6rem',
                        padding: '0.55rem 0.9rem',
                        borderRadius: '12px',
                        background: 'rgba(255,255,255,0.025)',
                        border: '1px solid rgba(255,255,255,0.06)',
                        color: 'var(--text-primary)',
                        fontFamily: 'inherit',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                        textAlign: 'left',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(0,242,254,0.08)';
                        e.currentTarget.style.borderColor = 'rgba(0,242,254,0.3)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(255,255,255,0.025)';
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)';
                      }}
                    >
                      {/* Пометка качества */}
                      <span
                        style={{
                          flexShrink: 0,
                          padding: '2px 7px',
                          borderRadius: '6px',
                          fontSize: '0.64rem',
                          fontWeight: 900,
                          letterSpacing: '0.05em',
                          background: item.quality === '4K'
                            ? 'rgba(255,184,0,0.14)'
                            : item.quality === '1080p'
                            ? 'rgba(0,242,254,0.12)'
                            : item.quality === '720p'
                            ? 'rgba(16,245,172,0.12)'
                            : 'rgba(255,255,255,0.07)',
                          color: item.quality === '4K' ? '#FFB800' : item.quality === '1080p' ? '#00F2FE' : item.quality === '720p' ? '#10F5AC' : 'rgba(240,242,248,0.55)',
                          border: `1px solid ${item.quality === '4K' ? 'rgba(255,184,0,0.4)' : item.quality === '1080p' ? 'rgba(0,242,254,0.35)' : item.quality === '720p' ? 'rgba(16,245,172,0.3)' : 'rgba(255,255,255,0.1)'}`,
                        }}
                      >
                        {item.quality}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.8rem', fontWeight: 600 }}>
                        {item.title}
                      </span>
                      {item.duration ? (
                        <span style={{ flexShrink: 0, fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                          {formatClock(item.duration)}
                        </span>
                      ) : null}
                      <span
                        style={{
                          flexShrink: 0,
                          width: '34px',
                          height: '34px',
                          borderRadius: '10px',
                          background: 'linear-gradient(135deg, rgba(0,198,251,0.2), rgba(138,43,226,0.2))',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Play size={13} fill="white" style={{ color: '#fff', marginLeft: '1px' }} />
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Torrent Releases */}
            {searchError && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.6rem',
                  padding: '0.75rem 1rem',
                  borderRadius: '14px',
                  marginBottom: '1rem',
                  background: 'rgba(255,84,112,0.1)',
                  border: '1px solid rgba(255,84,112,0.35)',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  color: 'rgba(255,160,180,0.95)',
                }}
              >
                <AlertTriangle size={16} color="#FF5470" style={{ flexShrink: 0 }} />
                <span>{searchError}</span>
              </div>
            )}
            {/* JacRed-источники восстанавливаются в фоне автоматически
                (динамический пул + racing probe) — плашка не требуется. */}
            {/* Серии: умный выбор эпизода (для сериалов) */}
            {movie.media_type === 'tv' && releases.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
                <button
                  onClick={() => setEpisodeUi({ release: releases[0], historyItem: undefined, initialView: 'picker' })}
                  className="btn-secondary"
                  style={{ borderRadius: '10px', padding: '0.45rem 1rem', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                >
                  <Tv size={13} style={{ color: 'var(--cyan)' }} />
                  Выбрать серию
                </button>
              </div>
            )}
            <TorrentSelector
              releases={releases}
              isLoading={isScraping}
              onPlayRelease={handlePlayRelease}
              onRetry={() => setSearchNonce((n) => n + 1)}
              error={searchError}
              isRutrackerSearching={isRutrackerSearching}
              tvSeasons={tvSeasons}
              seasonFilter={seasonFilter}
              onSeasonFilterChange={(s) => {
                setSeasonFilter(s);
                if (s > 0 && movie.media_type === 'tv' && window.electronAPI?.rutrackerSearch) {
                  // Сезон выбран — ищем RuTracker-раздачи именно этого сезона
                  // (темы вида «Название [S01]»); результат домёржится в список.
                  const baseQ = movie.title || movie.original_title || '';
                  const q = `${baseQ} S${String(s).padStart(2, '0')}`;
                  torrServerService.searchRutrackerLate(q, year).then(({ releases: late }) => {
                    if (!isMountedRef.current || late.length === 0) return;
                    setReleases((prev) => mergeReleasesByHash(prev, late));
                  }).catch(() => {});
                }
              }}
            />

            {/* ── Онлайн (KinoBox · Kodik): бесплатные потоки без TorrServer ──
                Альтернатива торрентам: прямой .m3u8 играется в Hls.js.
                Секция видна при загрузке/наличии потоков (прогрессив-дисклозюр):
                нет потоков → не занимает место, торренты остаются главными. */}
            {(isSearchingOnline || onlineStreams.length > 0) && (
            <div
              style={{
                marginTop: '1rem',
                background: 'rgba(14,15,21,0.93)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: '22px',
                overflow: 'hidden',
              }}
            >
              <div
                onClick={() => setIsOnlineOpen((o) => !o)}
                title={isOnlineOpen ? 'Свернуть онлайн-потоки' : 'Развернуть онлайн-потоки'}
                style={{
                  padding: '1.2rem 1.4rem 1rem',
                  borderBottom: isOnlineOpen ? '1px solid rgba(255,255,255,0.05)' : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.65rem',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <div
                  style={{
                    width: '34px',
                    height: '34px',
                    borderRadius: '10px',
                    background: 'linear-gradient(135deg, rgba(138,43,226,0.2), rgba(0,198,251,0.15))',
                    border: '1px solid rgba(138,43,226,0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 0 12px rgba(138,43,226,0.15)',
                    flexShrink: 0,
                  }}
                >
                  <Radio size={16} style={{ color: 'var(--cyan)' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                    Онлайн (KinoBox · Kodik)
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                    Бесплатные потоки без TorrServer · 1080p
                  </div>
                </div>
                {onlineStreams.length > 0 && (
                  <span
                    style={{
                      padding: '2px 8px',
                      borderRadius: '999px',
                      background: 'rgba(138,43,226,0.12)',
                      border: '1px solid rgba(138,43,226,0.35)',
                      color: 'var(--cyan)',
                      fontSize: '0.7rem',
                      fontWeight: 800,
                      flexShrink: 0,
                    }}
                  >
                    {onlineStreams.length}
                  </span>
                )}
                <span style={{ flexShrink: 0, color: 'var(--text-muted)', display: 'flex' }}>
                  {isOnlineOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </span>
              </div>

              {isOnlineOpen && (
                <div style={{ padding: '0.8rem 1.4rem 1.1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {isSearchingOnline ? (
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      {[1, 2, 3].map((n) => (
                        <div key={n} className="skeleton" style={{ width: '180px', height: '40px', borderRadius: '10px' }} />
                      ))}
                    </div>
                  ) : onlineStreams.length === 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      <Radio size={14} />
                      Онлайн-потоки не найдены — используйте торренты
                    </div>
                  ) : (
                    onlineStreams.map((stream) => (
                      <button
                        key={stream.id}
                        onClick={() => handlePlayOnline(stream)}
                        title={
                          stream.m3u8Url
                            ? `Воспроизвести в плеере Luminary: ${stream.source} · ${stream.translation}`
                            : `Открыть плеер ${stream.source} в браузере`
                        }
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.6rem',
                          padding: '0.55rem 0.9rem',
                          borderRadius: '12px',
                          background: 'rgba(255,255,255,0.025)',
                          border: '1px solid rgba(255,255,255,0.06)',
                          color: 'var(--text-primary)',
                          fontFamily: 'inherit',
                          cursor: 'pointer',
                          transition: 'all 0.2s ease',
                          textAlign: 'left',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(138,43,226,0.08)';
                          e.currentTarget.style.borderColor = 'rgba(138,43,226,0.3)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'rgba(255,255,255,0.025)';
                          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)';
                        }}
                      >
                        {/* Балансер */}
                        <span
                          style={{
                            flexShrink: 0,
                            padding: '2px 8px',
                            borderRadius: '6px',
                            fontSize: '0.64rem',
                            fontWeight: 900,
                            letterSpacing: '0.05em',
                            background: 'rgba(138,43,226,0.14)',
                            color: '#C9A2FF',
                            border: '1px solid rgba(138,43,226,0.4)',
                            maxWidth: '110px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {stream.source}
                        </span>
                        {/* Качество */}
                        <span
                          style={{
                            flexShrink: 0,
                            padding: '2px 7px',
                            borderRadius: '6px',
                            fontSize: '0.64rem',
                            fontWeight: 900,
                            letterSpacing: '0.05em',
                            background: stream.quality === '4K'
                              ? 'rgba(255,184,0,0.14)'
                              : stream.quality === '1080p'
                              ? 'rgba(0,242,254,0.12)'
                              : stream.quality === '720p'
                              ? 'rgba(16,245,172,0.12)'
                              : 'rgba(255,255,255,0.07)',
                            color: stream.quality === '4K' ? '#FFB800' : stream.quality === '1080p' ? '#00F2FE' : stream.quality === '720p' ? '#10F5AC' : 'rgba(240,242,248,0.55)',
                            border: `1px solid ${stream.quality === '4K' ? 'rgba(255,184,0,0.4)' : stream.quality === '1080p' ? 'rgba(0,242,254,0.35)' : stream.quality === '720p' ? 'rgba(16,245,172,0.3)' : 'rgba(255,255,255,0.1)'}`,
                          }}
                        >
                          {stream.quality}
                        </span>
                        {/* Перевод / озвучка */}
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.8rem', fontWeight: 600 }}>
                          {stream.translation}
                        </span>
                        <span
                          style={{
                            flexShrink: 0,
                            width: '34px',
                            height: '34px',
                            borderRadius: '10px',
                            background: stream.m3u8Url
                              ? 'linear-gradient(135deg, rgba(0,198,251,0.2), rgba(138,43,226,0.2))'
                              : 'rgba(255,255,255,0.05)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {stream.m3u8Url ? (
                            <Play size={13} fill="white" style={{ color: '#fff', marginLeft: '1px' }} />
                          ) : (
                            <ExternalLink size={13} style={{ color: 'var(--text-muted)' }} />
                          )}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            )}
          </div>
        </div>
      </div>
      {episodeUi && (
        <EpisodeResumeDialog
          movie={movie}
          release={episodeUi.release}
          historyItem={episodeUi.historyItem}
          releases={releases}
          onPlay={(rel, opts) => {
            setEpisodeUi(null);
            playRelease(rel, opts);
          }}
          onClose={() => setEpisodeUi(null)}
        />
      )}
    </div>
  );
};
