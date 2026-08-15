import React, { useEffect, useRef } from 'react';
import { Play, Info, Star, Calendar, Zap, ChevronRight } from 'lucide-react';
import { Movie } from '../types';
import { tmdbService } from '../services/tmdb';
import { extractYear } from '../utils/year';

interface HeroBannerProps {
  movie: Movie;
  onSelectMovie: (movie: Movie) => void;
}

export const HeroBanner: React.FC<HeroBannerProps> = ({ movie, onSelectMovie }) => {
  // TMDB CDN напрямую (w1280 для бэкдропа, w500 для постера)
  const backdropUrl = tmdbService.getImageUrl(movie.backdrop_path, 'w1280');
  const posterUrl = tmdbService.getImageUrl(movie.poster_path, 'w500');
  const year = extractYear(movie.release_date || movie.first_air_date) || '';
  const rating = movie.vote_average?.toFixed(1) || '8.0';
  const ratingNum = parseFloat(rating);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '520px',
        borderRadius: '24px',
        overflow: 'hidden',
        marginBottom: '3rem',
        border: '1px solid rgba(255,255,255,0.07)',
        boxShadow: '0 24px 80px rgba(0,0,0,0.7), 0 8px 24px rgba(0,0,0,0.5)',
      }}
    >
      {/* Background Image — центрирован по центру кадра (без смещения вправо),
          cover + translateZ для GPU-композитинга при скролле */}
      <img
        src={backdropUrl}
        alt={movie.title}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: 'center center',
          transform: 'translateZ(0)',
          willChange: 'transform',
        }}
      />

      {/* Multi-Layer Gradient Masks */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: [
            'linear-gradient(to top, #0A0B0E 0%, #0A0B0E 5%, rgba(10,11,14,0.9) 30%, rgba(10,11,14,0.5) 60%, rgba(10,11,14,0.15) 100%)',
          ].join(', '),
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(to right, rgba(10,11,14,0.98) 0%, rgba(10,11,14,0.7) 40%, rgba(10,11,14,0.2) 70%, transparent 100%)',
        }}
      />
      {/* Верхнее затемнение: безопасный отступ — лица/заголовки не теряются у края */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(to bottom, rgba(10,11,14,0.55) 0%, transparent 18%, transparent 100%)',
        }}
      />

      {/* Subtle cyan ambient shimmer on top edge */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '2px',
          background: 'linear-gradient(90deg, transparent, rgba(0,242,254,0.4), rgba(138,43,226,0.4), transparent)',
          opacity: 0.7,
        }}
      />

      {/* Content */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '2.5rem 3rem',
          maxWidth: '620px',
        }}
      >
        {/* Top Badges Row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
            marginBottom: '1rem',
            flexWrap: 'wrap',
          }}
        >
          {/* Rating Badge */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              padding: '0.25rem 0.65rem',
              borderRadius: '999px',
              background: 'rgba(255,184,0,0.15)',
              border: '1px solid rgba(255,184,0,0.4)',
              color: '#FFB800',
              fontSize: '0.78rem',
              fontWeight: 800,
              boxShadow: '0 0 12px rgba(255,184,0,0.2)',
            }}
          >
            <Star size={12} fill="#FFB800" />
            <span>{rating}</span>
          </div>

          {year && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
                padding: '0.25rem 0.65rem',
                borderRadius: '999px',
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: 'rgba(240,242,248,0.7)',
                fontSize: '0.78rem',
                fontWeight: 700,
              }}
            >
              <Calendar size={11} />
              <span>{year}</span>
            </div>
          )}

          <div
            style={{
              padding: '0.2rem 0.6rem',
              borderRadius: '6px',
              background: 'linear-gradient(135deg, rgba(0,198,251,0.15), rgba(138,43,226,0.15))',
              border: '1px solid rgba(0,242,254,0.25)',
              color: 'var(--cyan)',
              fontSize: '0.7rem',
              fontWeight: 900,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}
          >
            Топ Релиз
          </div>

          {/* Rating bar visual */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              opacity: 0.6,
            }}
          >
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                style={{
                  width: '3px',
                  height: i < Math.round(ratingNum / 2) ? '12px' : '6px',
                  borderRadius: '2px',
                  background:
                    i < Math.round(ratingNum / 2)
                      ? 'linear-gradient(to top, #00c6fb, #8A2BE2)'
                      : 'rgba(255,255,255,0.15)',
                  transition: 'all 0.3s ease',
                }}
              />
            ))}
          </div>
        </div>

        {/* Movie Title */}
        <h1
          style={{
            fontSize: 'clamp(1.8rem, 4vw, 3.2rem)',
            fontWeight: 900,
            letterSpacing: '-0.02em',
            lineHeight: 1.05,
            marginBottom: '0.9rem',
            background: 'linear-gradient(135deg, #fff 50%, rgba(255,255,255,0.72))',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}
        >
          {movie.title || movie.name}
        </h1>

        {/* Overview */}
        <p
          style={{
            color: 'rgba(240,242,248,0.62)',
            fontSize: '0.9rem',
            lineHeight: 1.6,
            marginBottom: '1.6rem',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {movie.overview || 'Один из самых захватывающих фильмов года. Погрузитесь в историю прямо сейчас.'}
        </p>

        {/* Action Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            onClick={() => onSelectMovie(movie)}
            className="btn-play"
            style={{ fontSize: '0.9rem', padding: '0.7rem 1.6rem' }}
          >
            <Play size={16} fill="white" />
            <span>Смотреть торрент</span>
          </button>

          <button
            onClick={() => onSelectMovie(movie)}
            className="btn-secondary"
            style={{ padding: '0.7rem 1.4rem', fontSize: '0.88rem' }}
          >
            <Info size={15} />
            <span>Подробнее</span>
          </button>
        </div>
      </div>

    </div>
  );
};
