/**
 * App.tsx — Android Touch версия Luminary.
 *
 * Отличия от Desktop:
 * - Bottom nav вместо header tabs
 * - PlayerTouch (gesture-based) вместо PlayerModal
 * - Bottom sheet модалки вместо center modals
 * - Touch-optimized CSS
 * - viewport-fit=cover, safe areas
 * - Импортирует общую логику из packages/core
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { torrServerService } from '../services/torrserver';
import { tmdbService } from '../services/tmdb';
import { library } from '../services/library';
import { toastBus } from '../services/toast';
import { Movie } from '../types';
import PlayerTouch from './components/PlayerTouch';
import HeaderBottom from './components/HeaderBottom';

// ── Каталог-типы ──
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
  const [isSearching, setIsSearching] = useState(false);
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);
  const [activeStream, setActiveStream] = useState<any>(null);
  const [catalog, setCatalog] = useState<CatalogRail[]>([]);
  const [favorites, setFavorites] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // ── Загрузка каталога ──
  useEffect(() => {
    const load = async () => {
      try {
        const [pop, trend, top, now, tv, anim] = await Promise.all([
          tmdbService.getPopularMovies(),
          tmdbService.getTrending(),
          tmdbService.getTopRatedMovies(),
          tmdbService.getNowPlayingMovies(),
          tmdbService.getPopularTV(),
          tmdbService.getMoviesByGenre(16), // Animation
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
    refreshLibrary();
  }, []);

  // ── Поиск ──
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); return; }
    setIsSearching(true);
    const t = setTimeout(async () => {
      try {
        setSearchResults(await tmdbService.searchMovies(searchQuery));
      } catch { setSearchResults([]); }
      setIsSearching(false);
    }, 400);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const refreshLibrary = () => {
    setFavorites(library.getFavorites());
    setHistory(library.getHistory());
  };

  // ── Воспроизведение торрента ──
  const handlePlayTorrent = async (movie: Movie, torrent: any) => {
    try {
      const res = torrent.torrentFile
        ? await torrServerService.addTorrentFile(torrent.torrentFile, movie.title)
        : await torrServerService.addMagnet(torrent.magnet, movie.title);
      if (res?.success || res?.data) {
        const hash = res.data?.hash;
        if (hash) {
          const streamUrl = await torrServerService.getStreamUrl(hash, torrent.fileIndex);
          setActiveStream({ url: streamUrl, title: movie.title, movie });
        }
      }
    } catch (err) {
      toastBus.push('Ошибка запуска торрента', 'error');
    }
  };

  // ── Навигация ──
  const handleTabChange = (tab: string) => {
    if (tab === 'search') {
      // Поиск — показать input
    }
    setActiveTab(tab);
  };

  // ── Рендер карточек ──
  const renderMovieCard = (movie: Movie) => (
    <div
      key={movie.id}
      className="movie-card"
      onClick={() => setSelectedMovie(movie)}
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
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {movie.title || movie.name}
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
          {movie.vote_average?.toFixed(1) || '—'}
        </div>
      </div>
    </div>
  );

  // ── Главный экран ──
  const renderHome = () => (
    <div style={{ padding: '16px', paddingBottom: '80px' }}>
      {catalog.map((rail) => rail.movies.length > 0 && (
        <div key={rail.title} style={{ marginBottom: '28px' }}>
          <h3 style={{ fontSize: '18px', fontWeight: 800, color: rail.color, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>{rail.icon}</span> {rail.title}
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '10px' }}>
            {rail.movies.slice(0, 12).map(renderMovieCard)}
          </div>
        </div>
      ))}
    </div>
  );

  // ── Поиск ──
  const renderSearch = () => (
    <div style={{ padding: '16px', paddingBottom: '80px' }}>
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Поиск фильмов..."
        className="input-glass"
        style={{ width: '100%', marginBottom: '16px' }}
        autoFocus
      />
      {searchResults.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '10px' }}>
          {searchResults.map(renderMovieCard)}
        </div>
      )}
    </div>
  );

  // ── Библиотека ──
  const renderLibrary = () => (
    <div style={{ padding: '16px', paddingBottom: '80px' }}>
      <h2 style={{ fontSize: '22px', fontWeight: 800, marginBottom: '16px' }}>Библиотека</h2>
      {favorites.length === 0 && history.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '40px' }}>Пусто</p>
      ) : (
        <>
          {favorites.length > 0 && (
            <div style={{ marginBottom: '24px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--coral)', marginBottom: '8px' }}>❤️ Избранное</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '10px' }}>
                {favorites.slice(0, 6).map((item) => renderMovieCard({
                  id: item.id, title: item.title, poster_path: item.poster,
                  vote_average: 0, overview: '', backdrop_path: null,
                }))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );

  // ── Плеер (полноэкранный) ──
  if (activeStream) {
    return (
      <PlayerTouch
        streamUrl={activeStream.url}
        title={activeStream.title}
        poster={activeStream.movie?.poster_path ? tmdbService.getImageUrl(activeStream.movie.poster_path, 'w500') : undefined}
        onClose={() => { setActiveStream(null); refreshLibrary(); }}
        onProgressSave={(cur, dur) => {
          if (activeStream.movie) {
            library.saveProgress({
              id: String(activeStream.movie.id),
              title: activeStream.title,
              poster: activeStream.movie.poster_path,
              mediaType: activeStream.movie.media_type,
            }, cur, dur);
            refreshLibrary();
          }
        }}
      />
    );
  }

  // ── Детали фильма (упрощённая bottom sheet версия) ──
  if (selectedMovie) {
    return (
      <div style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--bg-void)',
        zIndex: 60,
        overflowY: 'auto',
      }}>
        <button
          onClick={() => setSelectedMovie(null)}
          style={{
            position: 'fixed',
            top: '16px',
            left: '16px',
            zIndex: 70,
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            background: 'rgba(0,0,0,0.6)',
            border: 'none',
            color: '#fff',
            fontSize: '24px',
            cursor: 'pointer',
          }}
        >←</button>
        <img
          src={tmdbService.getImageUrl(selectedMovie.backdrop_path || selectedMovie.poster_path, 'w780')}
          alt=""
          style={{ width: '100%', height: '220px', objectFit: 'cover' }}
        />
        <div style={{ padding: '16px' }}>
          <h1 style={{ fontSize: '24px', fontWeight: 800, marginBottom: '8px' }}>
            {selectedMovie.title || selectedMovie.name}
          </h1>
          <p style={{ color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: '16px' }}>
            {selectedMovie.overview}
          </p>
          <button
            onClick={() => {
              handlePlayTorrent(selectedMovie, {
                magnet: 'magnet:?xt=urn:btih:demo',
                title: selectedMovie.title,
              });
              setSelectedMovie(null);
            }}
            className="btn-primary"
            style={{ width: '100%', justifyContent: 'center' }}
          >
            ▶ Смотреть торрент
          </button>
        </div>
      </div>
    );
  }

  // ── Основной layout ──
  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg-void)', paddingBottom: '72px' }}>
      <HeaderBottom activeTab={activeTab} setActiveTab={handleTabChange} />

      {activeTab === 'home' && renderHome()}
      {activeTab === 'movies' && renderHome()}
      {activeTab === 'search' && renderSearch()}
      {activeTab === 'library' && renderLibrary()}
    </div>
  );
};

export default App;
