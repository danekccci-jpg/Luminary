import React, { useEffect, useState, useRef } from 'react';
import { Header } from './components/Header';
import { HeroBanner } from './components/HeroBanner';
import { MovieGrid } from './components/MovieGrid';
import { MovieDetailsModal } from './components/MovieDetailsModal';
import { PlayerModal } from './components/PlayerModal';
import { SettingsModal } from './components/SettingsModal';
import { MagnetInputModal } from './components/MagnetInputModal';
import { Toaster } from './components/Toaster';
import { extractYear } from './utils/year';
import { clearMetaCache } from './services/cache';
import { Movie, TorrServerStatusInfo, UserSettings } from './types';
import { tmdbService, TMDB_GENRES } from './services/tmdb';
import { torrServerService } from './services/torrserver';
import { toastBus } from './services/toast';
import { library, formatClock, LibraryItem } from './services/library';
import { setCustomJacredUrl, refreshRemoteInstancePool, probeJacredPool } from './services/scrapers/jacred';
import { initLocalJacred, getJacredServerStatus, JacredServerStatus } from './services/jacredServer';
import { Heart, Bookmark, History, Play } from 'lucide-react';
import { Flame, TrendingUp, Award, Search as SearchIcon, Tv, Zap, Film } from 'lucide-react';

/** Zero-Config: фоновая авто-настройка источников на старте приложения. */
async function initZeroConfigSources() {
  // 1) Локальный встроенный JacRed (Zero-Config): Main Process скачивает бинарник
  //    и spawn'ит сервер на 127.0.0.1:9117; здесь ждём его и подключаем к пулу
  //    первым (retry покрывает первое скачивание ~46 МБ). Фон, не блокирует UI.
  const localReady = await initLocalJacred();
  // 2) Динамический пул JacRed-зеркал (remote CDN/Gist) + racing probe:
  //    мёртвые зеркала сразу уходят в карантин — первый поиск не ждёт таймаутов.
  try {
    await refreshRemoteInstancePool();
    if (localReady) {
      // Локальный инстанс жив — public-зеркала опрашиваем как резерв в хвосте
      await probeJacredPool();
    }
  } catch { /* не критично — поиск сам пробует пул */ }
  // 3) Silent VK Auth: гостевая сессия в фоне (кэш 12 ч, авто-обновление)
  try {
    await window.electronAPI?.vkAcquireSession?.();
  } catch { /* VK может быть недоступен — поиск тихо деградирует */ }
}

// ── Настройки: персистентность в localStorage + применение к сервисам ──
const SETTINGS_STORAGE_KEY = 'luminary_settings';

const defaultSettings: UserSettings = {
  tmdbApiKey: '',
  torrServerPort: 8090,
  ramCacheMB: 512,
  preBufferMB: 50,
  jackettUrl: '',
  jackettApiKey: '',
  vkToken: '',
  jacredUrl: '',
  kodikToken: '',
  autoStartTorrServer: true,
  autoCleanCacheOnClose: true,
  transcodeAudioToAac: true,
};

function loadSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return { ...defaultSettings, ...parsed };
      }
    }
  } catch { /* ignore */ }
  return { ...defaultSettings };
}

/** Применить настройки к модулям-сервисам (VK-токен, JacRed-инстанс, TMDB-ключ). */
function applySettingsToServices(s: UserSettings) {
  setCustomJacredUrl(s.jacredUrl || '');
  if (s.tmdbApiKey?.trim()) tmdbService.setApiKey(s.tmdbApiKey.trim());
}

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

/** Конвертация элемента библиотеки в Movie для MovieGrid/деталей. */
function libItemToMovie(item: LibraryItem): Movie {
  return {
    id: item.id as any,
    title: item.title,
    original_title: item.title,
    overview: '',
    poster_path: item.poster || null,
    backdrop_path: null,
    release_date: item.year ? `${item.year}-01-01` : undefined,
    vote_average: 0,
    genre_ids: [],
    media_type: item.mediaType || 'movie',
    year: item.year,
  };
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
  const [activeStream, setActiveStream]   = useState<{
    magnet: string;
    title: string;
    poster?: string;
    videoCodec?: string;
    audioCodec?: string;
    /** Прямой HLS/MP4 поток (VK Video) — плеер играет без TorrServer. */
    directUrl?: string;
    directQuality?: string;
    /** Referer для CDN прямого потока (онлайн-балансеры: kinobox/alloha…). */
    directReferer?: string;
    /** .torrent-файл (base64, rutracker) — добавляем в TorrServer вместо магнета. */
    torrentFile?: string;
    /** Сезон/серия (для сериалов) — история ведётся по эпизодам. */
    season?: number;
    episode?: number;
    mediaId?: string;
    mediaType?: 'movie' | 'tv';
    year?: string;
    startPosition?: number;
  } | null>(null);

  // ── Личная библиотека (localStorage) ──
  const [favorites, setFavorites] = useState<LibraryItem[]>([]);
  const [later, setLater]         = useState<LibraryItem[]>([]);
  const [history, setHistory]     = useState<LibraryItem[]>([]);

  const refreshLibrary = () => {
    setFavorites(library.getFavorites());
    setLater(library.getLater());
    setHistory(library.getHistory());
  };
  useEffect(() => {
    refreshLibrary();
    // Реактивность Избранное/Позже/История: любой toggle (модалка, карточка)
    // мгновенно перерисовывает вкладки без перезагрузки приложения
    const off = library.onChange(refreshLibrary);
    return () => off();
  }, []);

  /** Double-tap to top: повторный клик по активной «Главной» (таб или логотип). */
  const resetHome = () => {
    setSearchQuery('');        // очистка поискового запроса
    setActiveTab('home');      // сброс вкладки/фильтров
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const [isSettingsOpen, setIsSettingsOpen]   = useState(false);
  const [isMagnetModalOpen, setIsMagnetModalOpen] = useState(false);

  const [torrServerStatus, setTorrServerStatus] = useState<TorrServerStatusInfo>({ running: false, port: 8090 });
  const [jacredStatus, setJacredStatus] = useState<JacredServerStatus>({ running: false, starting: false, port: 9117 });

  const [ambientColor, setAmbientColor] = useState('rgba(0,242,254,0.05)');

  const [settings, setSettings] = useState<UserSettings>(loadSettings);

  // Initial data load
  useEffect(() => {
    // Сброс кеша метаданных (IndexedDB v2) — старые года раздач перезапросятся из TMDB
    clearMetaCache();
    // Применяем сохранённые настройки к сервисам (VK-токен, JacRed-инстанс, TMDB-ключ)
    applySettingsToServices(settings);
    // Zero-Config: динамический пул JacRed + гостевая VK-сессия (фоном)
    initZeroConfigSources();
    fetchCatalog();
    checkTorrServerStatus();
    // Push-подписка на изменения статуса TorrServer из Main Process —
    // UI (Header/Настройки) обновляется без опроса
    const off = window.electronAPI?.onTorrServerStatusChanged?.((st) => {
      setTorrServerStatus({
        running: !!st.running,
        starting: !!st.starting,
        port: st.port || 8090,
        error: st.error,
        errorLog: st.errorLog,
      });
    });
    return () => off?.();
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
        // TMDB-First: мгновенный поиск по API (Lampa-style), без блокирующего скрейпинга
        const results = await tmdbService.searchMovies(searchQuery);
        setSearchResults(results);
      } catch (err: any) {
        console.warn('[App] Search failed:', err?.message || err);
        setSearchResults([]);
        toastBus.push('Поиск временно недоступен — проверьте соединение и попробуйте снова.', 'error');
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
    // TMDB CDN: прямые ссылки, CORS разрешён для image.tmdb.org
    const imgUrl = tmdbService.getImageUrl(hero.poster_path, 'w500');
    if (!imgUrl) return;
    extractDominantHue(imgUrl).then(color => {
      setAmbientColor(color);
      document.documentElement.style.setProperty('--ambient-color', color);
    });
  }, [trendingMovies, popularMovies]);

  // TMDB-First: каталог строится из быстрых API-запросов TMDB,
  // а не из блокирующего скрейпинга HDRezka/Filmix на главной.
  const fetchCatalog = async () => {
    setIsLoadingCatalog(true);
    try {
      const [pop, trend, top, nowPlaying, tv, anim] = await Promise.all([
        tmdbService.getPopularMovies(),
        tmdbService.getTrending(),
        tmdbService.getTopRatedMovies(),
        tmdbService.getNowPlayingMovies(),
        tmdbService.getPopularTV(),
        tmdbService.getMoviesByGenre(TMDB_GENRES.animation.id),
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

  const checkJacredStatus = async () => {
    try {
      setJacredStatus(await getJacredServerStatus());
    } catch (e) {
      console.warn('[App] JacRed status check failed:', e);
      setJacredStatus({ running: false, starting: false, port: 9117 });
    }
  };

  const handleSaveSettings = (newSettings: UserSettings) => {
    setSettings(newSettings);
    // Персистентность: токены/URL инстансов переживают перезапуск приложения
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(newSettings));
    } catch { /* переполнение localStorage — игнорируем */ }
    applySettingsToServices(newSettings);
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
        onResetHome={resetHome}
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

            {/* ── Личная библиотека: Избранное / Позже / История ── */}
            {(activeTab === 'favorites' || activeTab === 'later') && (
              <MovieGrid
                title={activeTab === 'favorites' ? 'Избранное' : 'Посмотреть позже'}
                movies={(activeTab === 'favorites' ? favorites : later).map(libItemToMovie)}
                onSelectMovie={setSelectedMovie}
                icon={activeTab === 'favorites' ? <Heart size={20} /> : <Bookmark size={20} />}
                accentColor={activeTab === 'favorites' ? 'var(--coral)' : 'var(--cyan)'}
              />
            )}

            {activeTab === 'history' && (
              <div style={{ marginBottom: '2rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1.2rem' }}>
                  <History size={20} style={{ color: 'var(--cyan)' }} />
                  <h2 style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-primary)' }}>История просмотра</h2>
                </div>
                {history.length === 0 ? (
                  <div style={{ padding: '3rem', textAlign: 'center', border: '1px dashed rgba(255,255,255,0.12)', borderRadius: '20px' }}>
                    <History size={32} style={{ color: 'var(--text-muted)', margin: '0 auto 0.8rem', display: 'block' }} />
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Здесь появятся фильмы, которые вы смотрели</p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    {history.map((item) => {
                      const pct = item.duration ? Math.min(100, Math.round(((item.position || 0) / item.duration) * 100)) : 0;
                      return (
                        <div
                          key={item.id}
                          onClick={() => setSelectedMovie(libItemToMovie(item))}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '1rem',
                            padding: '0.7rem 1rem',
                            borderRadius: '16px',
                            background: 'rgba(255,255,255,0.025)',
                            border: '1px solid rgba(255,255,255,0.06)',
                            cursor: 'pointer',
                            transition: 'all 0.2s ease',
                          }}
                          onMouseEnter={(e) => {
                            (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.05)';
                            (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(0,242,254,0.2)';
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.025)';
                            (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.06)';
                          }}
                        >
                          <img
                            src={tmdbService.getImageUrl(item.poster, 'w185')}
                            alt={item.title}
                            style={{ width: '56px', aspectRatio: '2/3', objectFit: 'cover', borderRadius: '10px', background: '#121318', flexShrink: 0 }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {item.title}
                            </div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                              {item.year || ''} · просмотрено {new Date(item.updatedAt).toLocaleDateString()}
                            </div>
                            <div style={{ height: '4px', background: 'rgba(255,255,255,0.08)', borderRadius: '99px', marginTop: '0.5rem', overflow: 'hidden' }}>
                              <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg, #00F2FE, #8A2BE2)', borderRadius: '99px' }} />
                            </div>
                          </div>
                          {item.position && item.duration && item.position > 5 && item.position < item.duration - 10 && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedMovie(libItemToMovie(item));
                              }}
                              className="btn-primary"
                              style={{ borderRadius: '10px', padding: '0.5rem 0.9rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}
                            >
                              <Play size={12} fill="white" />
                              Продолжить с {formatClock(item.position)}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
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
          onOpenSettings={() => setIsSettingsOpen(true)}
          onPlayTorrent={(torrent) => {
            // Прогресс по конкретному эпизоду сериала (или фильму)
            const prog = selectedMovie
              ? library.getProgress(String(selectedMovie.id), torrent.season, torrent.episode)
              : null;
            // ⚠️ ZONE-навигация: НЕ сбрасываем selectedMovie — детали фильма
            // (выбор торрента/серии) остаются под плеером. X / Escape в плеере
            // возвращают сюда, а не на главный экран.
            setActiveStream({
              ...torrent,
              mediaId: selectedMovie ? String(selectedMovie.id) : undefined,
              mediaType: selectedMovie?.media_type,
              // Год — приоритет оригинальной даты TMDB, не year раздачи/ремастера
              year: extractYear(selectedMovie?.release_date || selectedMovie?.first_air_date) || selectedMovie?.year,
              startPosition: torrent.startPosition ?? prog?.position,
            });
            refreshLibrary();
          }}
        />
      )}

      {activeStream && (
        <PlayerModal
          magnet={activeStream.magnet}
          title={activeStream.title}
          poster={activeStream.poster}
          videoCodec={activeStream.videoCodec}
          audioCodec={activeStream.audioCodec}
          directUrl={activeStream.directUrl}
          directReferer={activeStream.directReferer}
          torrentFile={activeStream.torrentFile}
          startPosition={activeStream.startPosition}
          transcodeAudioToAac={settings.transcodeAudioToAac}
          onProgressSave={(cur, dur) => {
            if (activeStream.mediaId) {
              library.saveProgress(
                {
                  id: activeStream.mediaId,
                  title: activeStream.title,
                  poster: activeStream.poster,
                  year: activeStream.year,
                  mediaType: activeStream.mediaType,
                  season: activeStream.season,
                  episode: activeStream.episode,
                },
                cur, dur
              );
              refreshLibrary();
            }
          }}
          onClose={() => { refreshLibrary(); setActiveStream(null); }}
        />
      )}

      {isSettingsOpen && (
        <SettingsModal
          settings={settings}
          onSaveSettings={handleSaveSettings}
          onClose={() => setIsSettingsOpen(false)}
          torrServerStatus={torrServerStatus}
          onRefreshStatus={checkTorrServerStatus}
          jacredServerStatus={jacredStatus}
          onRefreshJacredStatus={checkJacredStatus}
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

      {/* Global toast notifications */}
      <Toaster />
    </div>
  );
};
