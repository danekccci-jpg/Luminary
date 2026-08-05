import React, { useEffect, useState } from 'react';
import { X, Star, Calendar, Clock, User, AlertTriangle, Play, Tv, MonitorPlay, Heart, Bookmark } from 'lucide-react';
import { library, LibraryItem } from '../services/library';
import { extractYear } from '../utils/year';
import { Movie, TorrentRelease, OnlineStream } from '../types';
import { tmdbService } from '../services/tmdb';
import { torrServerService } from '../services/torrserver';
import { toastBus } from '../services/toast';
import { TorrentSelector } from './TorrentSelector';

interface MovieDetailsModalProps {
  movie: Movie;
  onClose: () => void;
  onPlayTorrent: (torrent: {
    magnet: string;
    title: string;
    poster?: string;
    videoCodec?: string;
    audioCodec?: string;
  }) => void;
}

export const MovieDetailsModal: React.FC<MovieDetailsModalProps> = ({
  movie,
  onClose,
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
  const [streams, setStreams] = useState<OnlineStream[]>([]);
  const [isScraping, setIsScraping] = useState(true);
  const [isFindingStreams, setIsFindingStreams] = useState(true);
  const [searchError, setSearchError] = useState<string | null>(null);

  // TMDB-First: прямые постеры с CDN
  const backdropUrl = tmdbService.getImageUrl(movie.backdrop_path, 'w1280');
  const posterUrl   = tmdbService.getImageUrl(movie.poster_path, 'w500');

  // Extract year from movie (supports both TMDB release_date and HDRezka/Filmix year field)
  const year = extractYear(movie.year) || extractYear(movie.release_date || movie.first_air_date) || '';

  useEffect(() => {
    // TMDB-First: мгновенно показываем данные из карточки, фоном обогащаем деталями
    setDetails(movie);
    setIsScraping(true);
    setIsFindingStreams(true);
    setSearchError(null);

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

    // ── 1) Прямые плееры HDRezka / Filmix (on-demand) ──
    window.electronAPI?.findPlayers(primaryQuery, movie.original_title || '', year)
      .then((res) => {
        if (cancelled) return;
        setStreams(res.success ? res.streams : []);
        setIsFindingStreams(false);
      })
      .catch(() => {
        if (cancelled) return;
        setStreams([]);
        setIsFindingStreams(false);
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

    return () => { cancelled = true; };
  }, [movie]);

  const handlePlayRelease = (release: TorrentRelease) => {
    onPlayTorrent({
      magnet: release.magnet,
      title: `${movie.title} (${release.quality})`,
      poster: posterUrl,
      // Кодеки раздачи — плеер решает: играть или предложить VLC/IINA
      videoCodec: release.videoCodec,
      audioCodec: release.audioCodec,
    });
  };

  /** Открыть прямой плеер (HDRezka/Filmix) во внешнем браузере. */
  const handleOpenStream = (stream: OnlineStream) => {
    window.electronAPI?.openExternal(stream.url);
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
        background: 'rgba(0,0,0,0.82)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
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
          background: 'rgba(11,12,17,0.96)',
          backdropFilter: 'blur(30px)',
          WebkitBackdropFilter: 'blur(30px)',
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
            background: 'rgba(10,11,14,0.8)',
            backdropFilter: 'blur(10px)',
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
                      backdropFilter: 'blur(10px)',
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
                      backdropFilter: 'blur(10px)',
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

            {/* ── Смотреть онлайн: прямые плееры HDRezka/Filmix ── */}
            <div
              style={{
                marginBottom: '1rem',
                background: 'rgba(14,15,21,0.7)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
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
                    background: 'linear-gradient(135deg, rgba(138,43,226,0.2), rgba(0,198,251,0.2))',
                    border: '1px solid rgba(138,43,226,0.25)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 0 12px rgba(138,43,226,0.15)',
                    flexShrink: 0,
                  }}
                >
                  <MonitorPlay size={16} style={{ color: 'var(--purple)' }} />
                </div>
                <div>
                  <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                    Смотреть онлайн
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                    Прямые плееры HDRezka · Filmix
                  </div>
                </div>
              </div>
              <div style={{ padding: '1rem 1.4rem 1.2rem' }}>
                {isFindingStreams ? (
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {[1, 2, 3].map((n) => (
                      <div key={n} className="skeleton" style={{ width: '120px', height: '36px', borderRadius: '10px' }} />
                    ))}
                  </div>
                ) : streams.length === 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    <Tv size={14} />
                    Онлайн-плееры не найдены — используйте торренты ниже
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {streams.map((stream) => (
                      <button
                        key={stream.id}
                        onClick={() => handleOpenStream(stream)}
                        title={`Открыть плеер в браузере: ${stream.dubbing}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                          padding: '0.5rem 1rem',
                          borderRadius: '12px',
                          background: 'rgba(138,43,226,0.12)',
                          border: '1px solid rgba(138,43,226,0.4)',
                          color: '#B57BFF',
                          fontSize: '0.8rem',
                          fontWeight: 700,
                          fontFamily: 'inherit',
                          cursor: 'pointer',
                          transition: 'all 0.2s ease',
                          boxShadow: '0 0 12px rgba(138,43,226,0.12)',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(138,43,226,0.22)';
                          e.currentTarget.style.boxShadow = '0 0 16px rgba(138,43,226,0.3)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'rgba(138,43,226,0.12)';
                          e.currentTarget.style.boxShadow = '0 0 12px rgba(138,43,226,0.12)';
                        }}
                      >
                        <Play size={12} fill="#B57BFF" />
                        {stream.dubbing}
                      </button>
                    ))}
                  </div>
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
            <TorrentSelector
              releases={releases}
              isLoading={isScraping}
              onPlayRelease={handlePlayRelease}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
