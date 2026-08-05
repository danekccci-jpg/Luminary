import React, { useEffect, useState } from 'react';
import { X, Star, Calendar, Clock, User } from 'lucide-react';
import { Movie, TorrentRelease } from '../types';
import { catalogService } from '../services/catalog';
import { torrServerService } from '../services/torrserver';
import { TorrentSelector } from './TorrentSelector';

interface MovieDetailsModalProps {
  movie: Movie;
  onClose: () => void;
  onPlayTorrent: (torrent: { magnet: string; title: string; poster?: string }) => void;
}

export const MovieDetailsModal: React.FC<MovieDetailsModalProps> = ({
  movie,
  onClose,
  onPlayTorrent,
}) => {
  const [details, setDetails] = useState<Movie | null>(null);
  const [releases, setReleases] = useState<TorrentRelease[]>([]);
  const [isScraping, setIsScraping] = useState(true);

  // Use catalogService for image proxy
  const backdropUrl = catalogService.getImageUrl(movie.backdrop_path);
  const posterUrl   = catalogService.getImageUrl(movie.poster_path);

  // Extract year from movie (supports both TMDB release_date and HDRezka/Filmix year field)
  const year = movie.year
    || (movie.release_date ? new Date(movie.release_date).getFullYear().toString() : '')
    || (movie.first_air_date ? new Date(movie.first_air_date).getFullYear().toString() : '');

  useEffect(() => {
    // For HDRezka/Filmix items, all data is already in the movie object
    setDetails(movie);
    setIsScraping(true);

    // Lampa-style dual-language search:
    // 1. Primary: Russian title + year → finds more RU-dubbed releases on Rutor/JacRed
    // 2. Fallback: original_title + year → if no RU results
    const primaryQuery = movie.title || movie.original_title || '';
    const fallbackQuery =
      movie.original_title && movie.original_title !== movie.title
        ? movie.original_title
        : undefined;

    torrServerService
      .searchTorrents(primaryQuery, year, undefined, undefined, undefined, fallbackQuery)
      .then(res => {
        setReleases(res);
        setIsScraping(false);
      });
  }, [movie]);

  const handlePlayRelease = (release: TorrentRelease) => {
    onPlayTorrent({
      magnet: release.magnet,
      title: `${movie.title} (${release.quality})`,
      poster: posterUrl,
    });
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
                {movie.overview || 'Описание недоступно.'}
              </p>
            </div>

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
                          src={catalogService.getImageUrl(actor.profile_path)}
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

            {/* Torrent Releases */}
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
