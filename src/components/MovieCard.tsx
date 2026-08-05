import React, { useEffect, useState } from 'react';
import { Star, Play } from 'lucide-react';
import { Movie } from '../types';
import { catalogService } from '../services/catalog';

interface MovieCardProps {
  movie: Movie;
  onClick: () => void;
  index?: number;
}

export const MovieCard: React.FC<MovieCardProps> = ({ movie, onClick, index = 0 }) => {
  const [hovered, setHovered] = useState(false);
  const displayTitle = movie.title || movie.name || 'Без названия';

  // Poster URL through image proxy (luminary-img://)
  const primaryUrl = catalogService.getImageUrl(movie.poster_path);
  const [imgSrc, setImgSrc] = useState(primaryUrl || '');
  const [usedFallback, setUsedFallback] = useState(!primaryUrl);
  const [fallbackDataUri, setFallbackDataUri] = useState('');

  // Preload placeholder SVG for this title
  useEffect(() => {
    if (!primaryUrl || usedFallback) {
      catalogService.getPosterPlaceholder(displayTitle).then(setFallbackDataUri);
    }
  }, [primaryUrl, usedFallback, displayTitle]);

  // Set initial image
  useEffect(() => {
    if (primaryUrl) {
      setImgSrc(primaryUrl);
      setUsedFallback(false);
    } else if (fallbackDataUri) {
      setImgSrc(fallbackDataUri);
      setUsedFallback(true);
    }
  }, [primaryUrl, fallbackDataUri]);

  const year = movie.release_date
    ? new Date(movie.release_date).getFullYear()
    : movie.first_air_date
    ? new Date(movie.first_air_date).getFullYear()
    : movie.year || '';
  const rating = movie.vote_average?.toFixed(1) || '—';
  const isHighRated = parseFloat(rating) >= 8.0;

  const handleImgError = async () => {
    if (usedFallback) return;
    setUsedFallback(true);
    const placeholder = await catalogService.getPosterPlaceholder(displayTitle);
    setFallbackDataUri(placeholder);
    setImgSrc(placeholder);
  };

  // Determine tag display
  const isTV = movie.media_type === 'tv' || (movie as any).type === 'tv';
  const sourceLabel = movie.source === 'hdrezka' ? 'HDRezka' : movie.source === 'filmix' ? 'Filmix' : '';
  const quality = movie.quality || '';

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        borderRadius: '20px',
        overflow: 'hidden',
        cursor: 'pointer',
        background: 'rgba(255,255,255,0.04)',
        border: hovered
          ? '1px solid rgba(0,242,254,0.4)'
          : '1px solid rgba(255,255,255,0.06)',
        boxShadow: hovered
          ? '0 0 0 1px rgba(0,242,254,0.15), 0 12px 40px rgba(0,0,0,0.7), 0 4px 16px rgba(0,242,254,0.1)'
          : '0 4px 16px rgba(0,0,0,0.4)',
        transform: hovered ? 'translateY(-8px) scale(1.02)' : 'translateY(0) scale(1)',
        transition: 'all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)',
        animation: `fadeUp 0.4s ease ${Math.min(index, 24) * 0.03}s both`,
      }}
    >
      <div style={{ position: 'relative', aspectRatio: '2/3', overflow: 'hidden' }}>
        <img
          src={imgSrc || fallbackDataUri}
          alt={displayTitle}
          loading="lazy"
          onError={handleImgError}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: hovered ? 'scale(1.08)' : 'scale(1)',
            transition: 'transform 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
            background: 'linear-gradient(135deg, #0a0a0d, #12141c)',
          }}
        />

        {/* Hover overlay */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(to top, rgba(10,11,14,0.95) 0%, rgba(10,11,14,0.3) 40%, transparent 100%)',
            opacity: hovered ? 1 : 0,
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
              transform: hovered ? 'scale(1)' : 'scale(0.7)',
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
              background: 'rgba(10,11,14,0.75)',
              backdropFilter: 'blur(8px)',
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
};
