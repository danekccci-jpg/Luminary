import React from 'react';
import { MovieCard } from './MovieCard';
import { Movie } from '../types';

interface MovieGridProps {
  title: string;
  movies: Movie[];
  onSelectMovie: (movie: Movie) => void;
  icon?: React.ReactNode;
  accentColor?: string;
}

export const MovieGrid: React.FC<MovieGridProps> = ({
  title,
  movies,
  onSelectMovie,
  icon,
  accentColor = 'var(--cyan)',
}) => {
  if (movies.length === 0) return null;

  return (
    <section style={{ marginBottom: '3.5rem' }}>
      {/* Section Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          marginBottom: '1.4rem',
        }}
      >
        {/* Accent Bar */}
        <div
          style={{
            width: '3px',
            height: '24px',
            borderRadius: '2px',
            background: `linear-gradient(to bottom, ${accentColor}, transparent)`,
            boxShadow: `0 0 8px ${accentColor}`,
            flexShrink: 0,
          }}
        />

        {icon && (
          <div style={{ color: accentColor, display: 'flex', alignItems: 'center' }}>
            {icon}
          </div>
        )}

        <h2
          style={{
            fontSize: '1.25rem',
            fontWeight: 800,
            color: 'var(--text-primary)',
            letterSpacing: '-0.01em',
          }}
        >
          {title}
        </h2>

        <div
          style={{
            marginLeft: '0.5rem',
            padding: '2px 9px',
            borderRadius: '999px',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            fontSize: '0.72rem',
            fontWeight: 700,
            color: 'var(--text-muted)',
          }}
        >
          {movies.length}
        </div>

        {/* Decorative line */}
        <div
          style={{
            flex: 1,
            height: '1px',
            background: 'linear-gradient(to right, rgba(255,255,255,0.06), transparent)',
            marginLeft: '0.5rem',
          }}
        />
      </div>

      {/* Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))',
          gap: '1.1rem',
        }}
      >
        {movies.map((movie, idx) => (
          <MovieCard
            key={movie.id}
            movie={movie}
            index={idx}
            onClick={() => onSelectMovie(movie)}
          />
        ))}
      </div>
    </section>
  );
};
