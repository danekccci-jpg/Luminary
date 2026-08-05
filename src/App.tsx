import React, { useEffect, useState, useRef } from 'react';
import { Header } from './components/Header';
import { HeroBanner } from './components/HeroBanner';
import { MovieGrid } from './components/MovieGrid';
import { MovieDetailsModal } from './components/MovieDetailsModal';
import { PlayerModal } from './components/PlayerModal';
import { SettingsModal } from './components/SettingsModal';
import { MagnetInputModal } from './components/MagnetInputModal';
import { Movie, TorrServerStatusInfo, UserSettings } from './types';
import { catalogService } from './services/catalog';
import { torrServerService } from './services/torrserver';
import { Flame, TrendingUp, Award, Search as SearchIcon, Tv, Zap, Film } from 'lucide-react';

// ── Ambient backdrop hue extractor via canvas ──
function extractDominantHue(imageUrl: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 18;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve('rgba(0,242,254,0.05)'); return; }
        ctx.drawImage(img, 0, 0, 32, 18);
        const data = ctx.getImageData(0, 0, 32, 18).data;
        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
          const brightness = (data[i] + data[i+1] + data[i+2]) / 3;
          if (brightness > 20 && brightness < 220) {
            r += data[i]; g += data[i+1]; b += data[i+2]; count++;
          }
        }
        if (count > 0) {
          r = Math.round(r / count);
          g = Math.round(g / count);
          b = Math.round(b / count);
          resolve(`rgba(${r},${g},${b},0.12)`);
        } else {
          resolve('rgba(0,242,254,0.05)');
        }
      };
      img.onerror = () => resolve('rgba(0,242,254,0.05)');
      img.src = imageUrl + '?_=' + Date.now();
    } catch {
      resolve('rgba(0,242,254,0.05)');
    }
  });
}

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState('home');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Movie[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const [popularMovies, setPopularMovies]   = useState<Movie[]>([]);
  const [trendingMovies, setTrendingMovies] = useState<Movie[]>([]);
  const [topRatedMovies, setTopRatedMovies] = useState<Movie[]>([]);
  const [nowPlayingMovies, setNowPlayingMovies] = useState<Movie[]>([]);
  const [popularTV, setPopularTV]           = useState<Movie[]>([]);
  const [animation, setAnimation]           = useState<Movie[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(true);

  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);
  const [activeStream, setActiveStream]   = useState<{ magnet: string; title: string; poster?: string } | null>(null);
  const [isSettingsOpen, setIsSettingsOpen]   = useState(false);
  const [isMagnetModalOpen, setIsMagnetModalOpen] = useState(false);

  const [torrServerStatus, setTorrServerStatus] = useState<TorrServerStatusInfo>({ running: false, port: 8090 });

  const [ambientColor, setAmbientColor] = useState('rgba(0,242,254,0.05)');

  const [settings, setSettings] = useState<UserSettings>({
    tmdbApiKey: '',
    torrServerPort: 8090,
    ramCacheMB: 512,
    preBufferMB: 50,
    jackettUrl: '',
    jackettApiKey: '',
    autoStartTorrServer: true,
    autoCleanCacheOnClose: true,
    transcodeAudioToAac: true,
  });

  // Initial data load
  useEffect(() => {
    fetchCatalog();
    checkTorrServerStatus();
  }, []);

  // ── Global Search — API-backed, debounced ──
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    const t = setTimeout(async () => {
      try {
        const results = await catalogService.search(searchQuery);
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Dynamic ambient backdrop based on hero movie poster
  useEffect(() => {
    const hero = trendingMovies[0] || popularMovies[0];
    if (!hero?.poster_path) return;
    // Try to extract from proxy URL or direct
    const imgUrl = catalogService.getImageUrl(hero.poster_path);
    if (!imgUrl) return;
    extractDominantHue(imgUrl).then(color => {
      setAmbientColor(color);
      document.documentElement.style.setProperty('--ambient-color', color);
    });
  }, [trendingMovies, popularMovies]);

  const fetchCatalog = async () => {
    setIsLoadingCatalog(true);
    try {
      const [pop, trend, top, nowPlaying, tv, anim] = await Promise.all([
        catalogService.getPopularMovies(),
        catalogService.getTrendingMovies(),
        catalogService.getTopRatedMovies(),
        catalogService.getNowPlayingMovies(),
        catalogService.getPopularTV(),
        catalogService.getAnimation(),
      ]);
      setPopularMovies(pop);
      setTrendingMovies(trend);
      setTopRatedMovies(top);
      setNowPlayingMovies(nowPlaying);
      setPopularTV(tv);
      setAnimation(anim);
    } catch (e) {
      console.error('[App] Catalog load error:', e);
    } finally {
      setIsLoadingCatalog(false);
    }
  };

  const checkTorrServerStatus = async () => {
    try {
      const st = await torrServerService.getStatus();
      setTorrServerStatus(st);
    } catch (e) {
      console.warn('[App] TorrServer status check failed:', e);
      setTorrServerStatus({ running: false, port: 8090 });
    }
  };

  const handleSaveSettings = (newSettings: UserSettings) => {
    setSettings(newSettings);
    fetchCatalog();
  };

  const heroMovie = trendingMovies[0] || popularMovies[0];

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg-void)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font)',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Dynamic Ambient Backdrop Layer */}
      <div id="ambient-backdrop" aria-hidden="true">
        <div
          style={{
            position: 'absolute',
            top: '-10%',
            left: '-10%',
            width: '70%',
            height: '70%',
            borderRadius: '50%',
            background: `radial-gradient(circle, ${ambientColor} 0%, transparent 70%)`,
            filter: 'blur(80px)',
            transition: 'background 2.5s ease',
            animation: 'ambientShift 18s ease-in-out infinite',
            pointerEvents: 'none',
          }}
        />
        <div
          style={{
            position: 'absolute',
            bottom: '-10%',
            right: '-10%',
            width: '55%',
            height: '55%',
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(138,43,226,0.045) 0%, transparent 70%)',
            filter: 'blur(100px)',
            animation: 'ambientShift 24s ease-in-out infinite reverse',
            pointerEvents: 'none',
          }}
        />
      </div>

      {/* App Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenMagnetModal={() => setIsMagnetModalOpen(true)}
        torrServerStatus={torrServerStatus}
      />

      {/* Main Scrollable Content */}
      <main
        style={{
          flex: 1,
          position: 'relative',
          zIndex: 1,
          maxWidth: '1400px',
          width: '100%',
          margin: '0 auto',
          padding: '2rem 1.5rem 4rem',
        }}
      >
        {/* ── Global Search Results (API-backed) ── */}
        {searchQuery.trim() ? (
          <MovieGrid
            title={isSearching ? `Поиск: «${searchQuery}»…` : `Результаты поиска: «${searchQuery}»`}
            movies={searchResults}
            onSelectMovie={setSelectedMovie}
            icon={<SearchIcon size={20} />}
            accentColor="var(--cyan)"
          />
        ) : (
          <>
            {/* ── Loading Skeleton — shown instantly, before catalog arrives ── */}
            {isLoadingCatalog && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>
                <div
                  className="skeleton"
                  style={{
                    height: '360px',
                    borderRadius: '24px',
                    marginBottom: '0.5rem',
                  }}
                />
                {[1, 2, 3].map((n) => (
                  <div key={n} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div className="skeleton" style={{ width: '220px', height: '24px', borderRadius: '8px' }} />
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))', gap: '1.1rem' }}>
                      {[1, 2, 3, 4, 5, 6].map((i) => (
                        <div key={i} className="skeleton" style={{ aspectRatio: '2/3', borderRadius: '20px' }} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Hero Banner */}
            {heroMovie && (activeTab === 'home') && (
              <HeroBanner movie={heroMovie} onSelectMovie={setSelectedMovie} />
            )}

            {/* ── HDRezka / Filmix Catalog Rails ── */}
            {(activeTab === 'home' || activeTab === 'movies') && (
              <MovieGrid
                title="Популярные новинки"
                movies={popularMovies}
                onSelectMovie={setSelectedMovie}
                icon={<Flame size={20} />}
                accentColor="#FF5470"
              />
            )}

            {(activeTab === 'home' || activeTab === 'movies') && (
              <MovieGrid
                title="В тренде на этой неделе"
                movies={trendingMovies}
                onSelectMovie={setSelectedMovie}
                icon={<TrendingUp size={20} />}
                accentColor="var(--purple)"
              />
            )}

            {(activeTab === 'home' || activeTab === 'movies') && (
              <MovieGrid
                title="Новинки в HD"
                movies={nowPlayingMovies}
                onSelectMovie={setSelectedMovie}
                icon={<Zap size={20} />}
                accentColor="var(--cyan)"
              />
            )}

            {(activeTab === 'home' || activeTab === 'top') && (
              <MovieGrid
                title="Лучшие фильмы всех времён"
                movies={topRatedMovies}
                onSelectMovie={setSelectedMovie}
                icon={<Award size={20} />}
                accentColor="var(--amber)"
              />
            )}

            {(activeTab === 'home' || activeTab === 'movies') && (
              <MovieGrid
                title="Популярные сериалы"
                movies={popularTV}
                onSelectMovie={setSelectedMovie}
                icon={<Tv size={20} />}
                accentColor="var(--emerald)"
              />
            )}

            {(activeTab === 'home') && animation.length > 0 && (
              <MovieGrid
                title="Анимация и мультсериалы"
                movies={animation}
                onSelectMovie={setSelectedMovie}
                icon={<Film size={20} />}
                accentColor="var(--pink)"
              />
            )}
          </>
        )}
      </main>

      {/* ══ Modals ══ */}

      {selectedMovie && (
        <MovieDetailsModal
          movie={selectedMovie}
          onClose={() => setSelectedMovie(null)}
          onPlayTorrent={(torrent) => {
            setSelectedMovie(null);
            setActiveStream(torrent);
          }}
        />
      )}

      {activeStream && (
        <PlayerModal
          magnet={activeStream.magnet}
          title={activeStream.title}
          poster={activeStream.poster}
          transcodeAudioToAac={settings.transcodeAudioToAac}
          onClose={() => setActiveStream(null)}
        />
      )}

      {isSettingsOpen && (
        <SettingsModal
          settings={settings}
          onSaveSettings={handleSaveSettings}
          onClose={() => setIsSettingsOpen(false)}
          torrServerStatus={torrServerStatus}
          onRefreshStatus={checkTorrServerStatus}
        />
      )}

      {isMagnetModalOpen && (
        <MagnetInputModal
          onClose={() => setIsMagnetModalOpen(false)}
          onPlayMagnet={(magnet, title) => {
            setIsMagnetModalOpen(false);
            setActiveStream({ magnet, title });
          }}
        />
      )}
    </div>
  );
};
