import React, { useEffect, useState } from 'react';
import { Star, Play, Film } from 'lucide-react';
import { Movie } from '../types';
import { tmdbService } from '../services/tmdb';
import { extractYear } from '../utils/year';
import { keyActivate } from '../utils/focus';

interface MovieCardProps {
  movie: Movie;
  onClick: () => void;
  index?: number;
}

export const MovieCard: React.FC<MovieCardProps> = React.memo(({ movie, onClick, index = 0 }) => {
  const [hovered, setHovered] = useState(false);
  // Фокус (клавиатура / пульт D-pad) — те же визуалы, что и hover: карточка
  // подсвечивается, когда на неё навели курсором ИЛИ навели фокус пультом.
  const [focused, setFocused] = useState(false);
  const active = hovered || focused;
  const displayTitle = movie.title || movie.name || 'Без названия';

  // TMDB-First: прямой постер с CDN (image.tmdb.org — быстрый, CORS разрешён),
  // без IPC-проксирования.
  const posterUrl = tmdbService.getImageUrl(movie.poster_path, 'w500');
  const [imgSrc, setImgSrc] = useState(posterUrl || '');
  const [showPlaceholder, setShowPlaceholder] = useState(!posterUrl);

  // Set initial image
  useEffect(() => {
    if (posterUrl) {
      setImgSrc(posterUrl);
      setShowPlaceholder(false);
    } else {
      setShowPlaceholder(true);
    }
  }, [posterUrl]);

  const year = extractYear(movie.release_date || movie.first_air_date) || extractYear(movie.year) || '';
  const rating = movie.vote_average?.toFixed(1) || '—';
  const isHighRated = parseFloat(rating) >= 8.0;

  /** Постер не загрузился (404/сеть) — показываем градиентную заглушку. */
  const handleImgError = () => {
    setShowPlaceholder(true);
  };

  // Determine tag display
  const isTV = movie.media_type === 'tv' || (movie as any).type === 'tv';
  const sourceLabel = movie.source === 'hdrezka' ? 'HDRezka' : movie.source === 'filmix' ? 'Filmix' : '';
  const quality = movie.quality || '';

  return (
    <div
      className="movie-card"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={(e) => keyActivate(e, onClick)}
      tabIndex={0}
      role="button"
      aria-label={displayTitle}
      style={{
        position: 'relative',
        borderRadius: '20px',
        overflow: 'hidden',
        cursor: 'pointer',
        background: '#121318',
        border: active
          ? '1px solid rgba(0,242,254,0.4)'
          : '1px solid rgba(255,255,255,0.06)',
        boxShadow: active
          ? '0 0 0 1px rgba(0,242,254,0.15), 0 12px 40px rgba(0,0,0,0.7), 0 4px 16px rgba(0,242,254,0.1)'
          : '0 4px 16px rgba(0,0,0,0.4)',
        transform: active ? 'translateY(-8px) scale(1.02)' : 'translateY(0) scale(1)',
        transition: 'all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)',
        willChange: 'transform',
        animation: `fadeUp 0.4s ease ${Math.min(index, 24) * 0.03}s both`,
      }}
    >
      <div style={{ position: 'relative', aspectRatio: '2/3', overflow: 'hidden' }}>
        {showPlaceholder ? (
          /* ── Gradient placeholder: icon + title (poster unavailable) ── */
          <div
            style={{
              width: '100%',
              height: '100%',
              background:
                'linear-gradient(145deg, #121318 0%, #1a1030 55%, #0a0a0d 100%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.6rem',
              padding: '1rem',
              transform: active ? 'scale(1.08)' : 'scale(1)',
              transition: 'transform 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
            }}
          >
            <div
              style={{
                width: '46px',
                height: '46px',
                borderRadius: '14px',
                background: 'linear-gradient(135deg, #00c6fb 0%, #8A2BE2 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 18px rgba(0,198,251,0.35)',
                flexShrink: 0,
              }}
            >
              <Film size={20} color="#fff" />
            </div>
            <div
              style={{
                fontSize: '0.7rem',
                fontWeight: 700,
                color: 'rgba(240,242,248,0.72)',
                textAlign: 'center',
                lineHeight: 1.35,
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                wordBreak: 'break-word',
              }}
            >
              {displayTitle}
            </div>
          </div>
        ) : (
          <img
            src={imgSrc}
            alt={displayTitle}
            loading="lazy"
            onError={handleImgError}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: active ? 'scale(1.08)' : 'scale(1)',
              transition: 'transform 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
              background: 'linear-gradient(135deg, #121318, #1a1030)',
            }}
          />
        )}

        {/* Hover overlay */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(to top, rgba(10,11,14,0.95) 0%, rgba(10,11,14,0.3) 40%, transparent 100%)',
            opacity: active ? 1 : 0,
            transition: 'opacity 0.3s ease',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              width: '52px',
              height: '52px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #00c6fb, #8A2BE2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 24px rgba(0,198,251,0.5)',
              transform: active ? 'scale(1)' : 'scale(0.7)',
              transition: 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
            }}
          >
            <Play size={22} fill="white" color="white" style={{ marginLeft: '3px' }} />
          </div>
        </div>

        {/* Source badge */}
        {sourceLabel && (
          <div
            style={{
              position: 'absolute',
              top: '8px',
              left: '8px',
              padding: '2px 7px',
              borderRadius: '6px',
              background: sourceLabel === 'HDRezka'
                ? 'rgba(138,43,226,0.7)'
                : 'rgba(255,184,0,0.7)',
              fontSize: '0.6rem',
              fontWeight: 800,
              color: '#fff',
              letterSpacing: '0.05em',
            }}
          >
            {sourceLabel}
          </div>
        )}

        {/* Type badge */}
        {isTV && (
          <div
            style={{
              position: 'absolute',
              top: '8px',
              right: quality ? '8px' : '8px',
              padding: '2px 7px',
              borderRadius: '6px',
              background: 'rgba(16,245,172,0.7)',
              fontSize: '0.6rem',
              fontWeight: 800,
              color: '#fff',
            }}
          >
            Сериал
          </div>
        )}

        {/* Quality badge */}
        {quality && (
          <div
            style={{
              position: 'absolute',
              top: '8px',
              right: '8px',
              padding: '2px 7px',
              borderRadius: '6px',
              background: 'rgba(0,0,0,0.7)',
              fontSize: '0.6rem',
              fontWeight: 800,
              color: '#00F2FE',
              letterSpacing: '0.04em',
            }}
          >
            {quality}
          </div>
        )}

        {/* Rating */}
        {isHighRated && (
          <div
            style={{
              position: 'absolute',
              bottom: '8px',
              right: '8px',
              display: 'flex',
              alignItems: 'center',
              gap: '3px',
              padding: '3px 8px',
              borderRadius: '999px',
              background: 'rgba(10,11,14,0.88)',
              border: '1px solid rgba(255,184,0,0.35)',
              fontSize: '0.7rem',
              fontWeight: 800,
              color: '#FFB800',
            }}
          >
            <Star size={10} fill="#FFB800" />
            {rating}
          </div>
        )}
      </div>

      <div style={{ padding: '0.75rem 0.85rem 0.9rem' }}>
        <div
          style={{
            fontSize: '0.82rem',
            fontWeight: 700,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginBottom: '2px',
          }}
        >
          {displayTitle}
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>
          {year || '—'}
        </div>
      </div>
    </div>
  );
});
