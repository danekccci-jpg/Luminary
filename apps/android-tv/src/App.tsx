/**
 * App.tsx — Android TV версия Luminary (управление пультом).
 *
 * Отличия:
 * - Sidebar навигация (слева, фокусируется стрелками)
 * - PlayerTV (D-pad controls) вместо PlayerModal
 * - Полноэкранные модалки без backdrop
 * - Крупный шрифт (22px body)
 * - Фокус-кольца на всех элементах
 * - Нет hover/cursor
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { torrServerService } from './services/torrserver';
import { tmdbService } from './services/tmdb';
import { library } from './services/library';
import { toastBus } from './services/toast';
import { Movie } from './types';
import PlayerTV from './components/PlayerTV';

interface CatalogRail {
  title: string;
  icon: string;
  color: string;
  movies: Movie[];
}

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState('home');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Movie[]>([]);
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);
  const [activeStream, setActiveStream] = useState<any>(null);
  const [catalog, setCatalog] = useState<CatalogRail[]>([]);

  // ── Автозапуск TorrServer ──
  useEffect(() => {
    const startServer = async () => {
      try {
        const status = await torrServerService.getStatus();
        if (!status.running) {
          console.log('[App] TorrServer not running, starting...');
          await torrServerService.startServer();
        } else {
          console.log('[App] TorrServer already running');
        }
      } catch (err) {
        console.warn('[App] TorrServer start failed:', err);
      }
    };
    startServer();
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const [pop, trend, top, now, tv, anim] = await Promise.all([
          tmdbService.getPopularMovies(),
          tmdbService.getTrending(),
          tmdbService.getTopRatedMovies(),
          tmdbService.getNowPlayingMovies(),
          tmdbService.getPopularTV(),
          tmdbService.getMoviesByGenre(16),
        ]);
        setCatalog([
          { title: 'Популярные', icon: '🔥', color: '#FF5470', movies: pop },
          { title: 'В тренде', icon: '📈', color: '#8A2BE2', movies: trend },
          { title: 'Топ фильмы', icon: '🏆', color: '#FFB800', movies: top },
          { title: 'Сейчас в кино', icon: '⚡', color: '#00F2FE', movies: now },
          { title: 'Сериалы', icon: '📺', color: '#10F5AC', movies: tv },
          { title: 'Анимация', icon: '🎨', color: '#D946EF', movies: anim },
        ]);
      } catch (err) {
        console.error('[App] Catalog error:', err);
      }
    };
    load();
  }, []);

  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); return; }
    const t = setTimeout(async () => {
      try { setSearchResults(await tmdbService.searchMovies(searchQuery)); }
      catch { setSearchResults([]); }
    }, 400);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Back button handler
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Backspace') {
        if (activeStream) { setActiveStream(null); return; }
        if (selectedMovie) { setSelectedMovie(null); return; }
        if (searchQuery) { setSearchQuery(''); return; }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeStream, selectedMovie, searchQuery]);

  const renderMovieCard = (movie: Movie) => (
    <div
      key={movie.id}
      className="movie-card"
      tabIndex={0}
      role="button"
      onClick={() => setSelectedMovie(movie)}
      onKeyDown={(e) => { if (e.key === 'Enter') setSelectedMovie(movie); }}
      style={{
        borderRadius: '16px',
        overflow: 'hidden',
        background: '#121318',
        border: '1px solid rgba(255,255,255,0.06)',
        cursor: 'pointer',
      }}
    >
      <img
        src={tmdbService.getImageUrl(movie.poster_path, 'w300')}
        alt={movie.title || movie.name}
        loading="lazy"
        style={{ width: '100%', aspectRatio: '2/3', objectFit: 'cover', display: 'block' }}
      />
      <div style={{ padding: '12px 16px' }}>
        <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {movie.title || movie.name}
        </div>
        <div style={{ fontSize: '14px', color: 'var(--text-muted)', marginTop: '4px' }}>
          ⭐ {movie.vote_average?.toFixed(1) || '—'}
        </div>
      </div>
    </div>
  );

  const sidebarTabs = [
    { id: 'home', icon: '🏠', label: 'Главная' },
    { id: 'movies', icon: '🎬', label: 'Фильмы' },
    { id: 'search', icon: '🔍', label: 'Поиск' },
    { id: 'library', icon: '📚', label: 'Библиотека' },
  ];

  const renderContent = () => {
    if (activeTab === 'search') {
      return (
        <div style={{ padding: '0 40px 40px 320px' }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Поиск фильмов..."
            className="input-glass"
            autoFocus
            style={{ width: '100%', marginBottom: '24px' }}
          />
          {searchResults.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '24px' }}>
              {searchResults.map(renderMovieCard)}
            </div>
          )}
        </div>
      );
    }

    return (
      <div style={{ padding: '0 40px 40px 320px' }}>
        {catalog.map((rail) => rail.movies.length > 0 && (
          <div key={rail.title} style={{ marginBottom: '36px' }}>
            <h3 style={{ fontSize: '24px', fontWeight: 800, color: rail.color, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '28px' }}>{rail.icon}</span> {rail.title}
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '24px' }}>
              {rail.movies.slice(0, 10).map(renderMovieCard)}
            </div>
          </div>
        ))}
      </div>
    );
  };

  // Player
  if (activeStream) {
    return (
      <PlayerTV
        streamUrl={activeStream.url}
        title={activeStream.title}
        onClose={() => setActiveStream(null)}
      />
    );
  }

  // Movie details (fullscreen)
  if (selectedMovie) {
    return (
      <div style={{ minHeight: '100dvh', background: 'var(--bg-void)', padding: '40px 60px 40px 320px' }}>
        <button
          onClick={() => setSelectedMovie(null)}
          tabIndex={0}
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '16px',
            color: '#fff',
            fontSize: '20px',
            padding: '12px 24px',
            cursor: 'pointer',
            marginBottom: '24px',
          }}
        >
          ← Назад
        </button>
        <img
          src={tmdbService.getImageUrl(selectedMovie.backdrop_path || selectedMovie.poster_path, 'w780')}
          alt=""
          style={{ width: '100%', height: '360px', objectFit: 'cover', borderRadius: '20px', marginBottom: '24px' }}
        />
        <h1 style={{ fontSize: '36px', fontWeight: 800, marginBottom: '12px' }}>
          {selectedMovie.title || selectedMovie.name}
        </h1>
        <p style={{ fontSize: '20px', color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: '800px', marginBottom: '32px' }}>
          {selectedMovie.overview}
        </p>
        <button
          tabIndex={0}
          onClick={() => {
            setActiveStream({ url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4', title: selectedMovie.title || '' });
            setSelectedMovie(null);
          }}
          className="btn-primary"
          style={{ fontSize: '22px', padding: '20px 48px' }}
        >
          ▶ Смотреть
        </button>
      </div>
    );
  }

  // Main layout with sidebar
  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-void)', display: 'flex' }}>
      {/* Sidebar */}
      <nav style={{
        position: 'fixed',
        left: 0,
        top: 0,
        bottom: 0,
        width: '280px',
        background: 'rgba(10, 11, 14, 0.95)',
        borderRight: '1px solid rgba(255,255,255,0.08)',
        padding: '60px 24px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        zIndex: 40,
      }}>
        <div style={{ fontSize: '24px', fontWeight: 900, color: '#00F2FE', marginBottom: '24px', paddingLeft: '20px' }}>
          🌠 Luminary
        </div>
        {sidebarTabs.map((tab) => (
          <button
            key={tab.id}
            tabIndex={0}
            className={`tv-nav-item ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '16px 20px',
              borderRadius: '12px',
              border: 'none',
              background: activeTab === tab.id ? 'rgba(0, 242, 254, 0.12)' : 'transparent',
              color: activeTab === tab.id ? '#00F2FE' : 'rgba(240, 242, 248, 0.6)',
              fontSize: '20px',
              fontWeight: 600,
              cursor: 'pointer',
              textAlign: 'left',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              minHeight: '56px',
            }}
          >
            <span style={{ fontSize: '24px' }}>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Content */}
      {renderContent()}
    </div>
  );
};

export default App;
