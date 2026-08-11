import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { X, Star, Calendar, Clock, User, AlertTriangle, Play, Heart, Bookmark, Tv, Radio, ChevronDown, ChevronUp } from 'lucide-react';
import { library, LibraryItem, formatClock } from '../services/library';
import { extractYear } from '../utils/year';
import { parseTorrentMeta } from '../utils/torrentMeta';
import { Movie, TorrentRelease, OnlineBalancerStream } from '../types';
import { tmdbService } from '../services/tmdb';
import { torrServerService } from '../services/torrserver';
import { mergeReleasesByHash } from '../services/scrapers/jacred';
import { toastBus } from '../services/toast';
import { searchVkVideo, VkVideoItem, normalizeVkTitle } from '../services/vkVideoService';
import { searchOnlineStreams } from '../services/onlineBalancers';
import { TorrentSelector } from './TorrentSelector';
import { EpisodeResumeDialog, findRelease } from './EpisodeResumeDialog';
import { useFocusTrap, keyActivate } from '../utils/focus';
import { registerBackHandler } from '../utils/tv';

interface MovieDetailsModalProps {
  movie: Movie;
  onClose: () => void;
  /** Открыть окно настроек (для получения VK-токена). */
  onOpenSettings?: () => void;
  onPlayTorrent: (torrent: {
    magnet: string;
    title: string;
    poster?: string;
    videoCodec?: string;
    audioCodec?: string;
    /** Прямой HLS/MP4 поток (VK Video / онлайн-балансеры) — плеер играет без TorrServer. */
    directUrl?: string;
    directQuality?: string;
    /** Referer для CDN прямого потока (онлайн-балансеры: kinobox/alloha…). */
    directReferer?: string;
    /** .torrent-файл (base64, rutracker) — в TorrServer вместо магнета. */
    torrentFile?: string;
    /** Сезон/серия (для сериалов) — история ведётся по эпизодам. */
    season?: number;
    episode?: number;
    /** Следующая серия (S/E) — плеер покажет кнопку на энд-скрине. */
    nextEpisode?: { season: number; episode: number } | null;
    /** Запустить следующую серию (резолвит раздачу из списка и переигрывает). */
    onPlayNext?: () => void;
    /** Явный таймкод возобновления (из умного меню серий). */
    startPosition?: number;
  }) => void;
}

// ── Единая модель онлайн-секции ──
// VK и балансеры приводятся к общему виду: карточка = (источник + фильм),
// внутри — варианты «озвучка · качество», которые выбираются перед просмотром.

interface OnlineVariant {
  key: string;
  /** Озвучка: из заголовка VK / translation балансера. */
  dubbing?: string;
  quality: string;
  /** Длительность (VK), секунды. */
  duration?: number;
  // VK:
  hlsUrl?: string;
  mp4Url?: string;
  // Балансер:
  m3u8Url?: string;
  referer?: string;
  iframeUrl?: string;
}

interface OnlineCard {
  key: string;
  /** Подпись источника: VK / Kodik / Collaps… */
  sourceLabel: string;
  sourceTone: 'vk' | 'balancer';
  title: string;
  variants: OnlineVariant[];
}

const QUALITY_ORDER: Record<string, number> = { '4K': 0, '1080p': 1, '720p': 2, '480p': 3, SD: 4 };

function qualityRank(q: string): number {
  return QUALITY_ORDER[q] ?? 9;
}

/** Заголовок карточки VK: без «смотреть онлайн»/качества/студии на конце. */
function cleanStreamTitle(title: string): string {
  return (
    String(title || '')
      .replace(/\s*(?:смотреть\s*онлайн|в\s*хорошем\s*качестве|бесплатно|полностью|фильм)\s*$/i, '')
      .replace(/\s+[-–—].*(?:смотреть|онлайн).*$/i, '')
      .replace(/\s+(?:дубляж|многоголос|двухголос|оригинал|субтитры|lost\s?film|hdrezka|rhs|ozz)\s*$/i, '')
      .trim() || 'Онлайн-поток'
  );
}

export const MovieDetailsModal: React.FC<MovieDetailsModalProps> = ({
  movie,
  onClose,
  onOpenSettings,
  onPlayTorrent,
}) => {
  const [details, setDetails] = useState<Movie | null>(null);
  const [isFav, setIsFav] = useState(() => library.isFavorite(String(movie.id)));
  const [isLater, setIsLater] = useState(() => library.isInLater(String(movie.id)));

  const libItem = (): Omit<LibraryItem, 'updatedAt'> => {
    // Обогащённые TMDB-данные (details ?? movie) сохраняем в библиотеку,
    // чтобы карточка/модалка из избранного не теряли рейтинг и описание.
    const src = details ?? movie;
    return {
      id: String(movie.id),
      title: src.title || src.name || 'Без названия',
      poster: src.poster_path,
      year: src.year || (src.release_date || '').slice(0, 4),
      mediaType: src.media_type || 'movie',
      rating: typeof src.vote_average === 'number' ? src.vote_average : undefined,
      overview: src.overview || undefined,
      backdrop: src.backdrop_path,
    };
  };

  const toggleFav = () => { setIsFav(library.toggleFavorite(libItem())); };
  const toggleLater = () => { setIsLater(library.toggleLater(libItem())); };
  const [releases, setReleases] = useState<TorrentRelease[]>([]);
  const [vkItems, setVkItems] = useState<VkVideoItem[]>([]);
  /** Онлайн-потоки (KinoBox/Kodik) — бесплатная альтернатива торрентам. */
  const [onlineStreams, setOnlineStreams] = useState<OnlineBalancerStream[]>([]);
  const [isSearchingOnline, setIsSearchingOnline] = useState(true);
  /** Секция «Онлайн» свёрнута/развёрнута (переключатель). */
  const [isOnlineOpen, setIsOnlineOpen] = useState(true);
  /** Выбранная карточка онлайн-секции — диалог выбора озвучки перед стартом. */
  const [pendingStream, setPendingStream] = useState<OnlineCard | null>(null);
  const [isScraping, setIsScraping] = useState(true);
  /** Фоновый поиск RuTracker ещё идёт (раздачи приедут позже, реактивно). */
  const [isRutrackerSearching, setIsRutrackerSearching] = useState(false);
  const [isSearchingVk, setIsSearchingVk] = useState(true);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** История просмотра (сериалы: сезон/серия + процент) — для умного меню запуска. */
  const [histItems, setHistItems] = useState<LibraryItem[]>([]);
  /** Умное меню запуска серии (диалог продолжения / пикер серий). */
  const [episodeUi, setEpisodeUi] = useState<{
    release: TorrentRelease;
    historyItem?: LibraryItem;
    initialView: 'dialog' | 'picker';
  } | null>(null);

  // TMDB-First: прямые постеры с CDN. Обогащённые данные (details) приходят
  // фоном — берём их в приоритете, иначе у Избранного/Истории постер и рейтинг
  // застревали бы в «пустых» значениях карточки (0.0 / заглушка).
  const m = details ?? movie;
  const backdropUrl = tmdbService.getImageUrl(m.backdrop_path, 'w1280');
  const posterUrl   = tmdbService.getImageUrl(m.poster_path, 'w500');
  // Постера нет/битый URL — сразу показываем SVG-заглушку с названием.
  const posterPlaceholder = tmdbService.getPosterPlaceholder(movie.title || movie.name || '');
  const posterSrc = posterUrl || posterPlaceholder;

  // Год — строго из оригинальной даты релиза (release_date / first_air_date),
  // movie.year (год раздачи HDRezka/Filmix, ремастер 4K) — только как fallback.
  const year = extractYear(m.release_date || m.first_air_date) || extractYear(m.year) || '';

  /** Сколько сезонов в сериале: TMDB (details.seasons) + максимум из раздач. */
  const tvSeasons = useMemo(() => {
    if (movie.media_type !== 'tv') return 0;
    let max = 0;
    const tmdbSeasons = (details as any)?.seasons;
    if (Array.isArray(tmdbSeasons)) {
      for (const s of tmdbSeasons) {
        const n = Number(s?.season_number);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    for (const r of releases) {
      const meta = parseTorrentMeta(r.title);
      // seasonsTo = конец диапазона (S01-S03 → 3); seasons = начало
      const maxSeason = meta.seasonsTo != null && meta.seasonsTo > (meta.seasons ?? 0) ? meta.seasonsTo : meta.seasons;
      if (maxSeason != null && maxSeason > max) max = maxSeason;
    }
    return max;
  }, [movie, details, releases]);

  /** Данные TMDB о сезонах (season_number + episode_count) — для пикера серий. */
  const tmdbSeasons = useMemo(() => {
    const raw = (details as any)?.seasons;
    if (!Array.isArray(raw)) return undefined;
    return raw
      .filter((s: any) => s && typeof s === 'object' && Number(s.season_number) > 0)
      .map((s: any) => ({ season_number: Number(s.season_number), episode_count: Number(s.episode_count) || 0 }))
      .sort((a: any, b: any) => a.season_number - b.season_number);
  }, [details]);

  /** Счётчик «Повторить поиск» — инкремент перезапускает поиск раздач. */
  const [searchNonce, setSearchNonce] = useState(0);
  /** Фильтр сезона для сериалов (0 = все). Смена сезона переищет RuTracker. */
  const [seasonFilter, setSeasonFilter] = useState(0);

  // ── TV/клавиатура: focus trap внутри модалки + Back (пульт/Escape) закрывает ──
  const modalRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(true, modalRef);
  useEffect(() => registerBackHandler(() => { onClose(); return true; }), [onClose]);
  /** Модалка ещё смонтирована (guard для фоновых ответов поиска). */
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    // TMDB-First: мгновенно показываем данные из карточки, фоном обогащаем деталями
    setDetails(movie);
    setReleases([]); // новый фильм/повторный поиск — старые раздачи не мёржатся
    setIsScraping(true);
    setIsSearchingVk(true);
    setIsSearchingOnline(true);
    setOnlineStreams([]);
    setSearchError(null);
    setHistItems(library.getHistory()); // история (сезон/серия, прогресс) для умного меню
    setEpisodeUi(null);

    // Lampa-style dual-language search:
    // 1. Primary: Russian title + year → finds more RU-dubbed releases on Rutor/JacRed
    // 2. Fallback: original_title + year → if no RU results
    // Названия из Истории/Избранного содержат суффикс качества («… (4K)»,
    // «… (SD)», «… [VK SD]») — такой запрос даёт 0 результатов на rutracker
    // (nm-поиск по мусорному хвосту пуст) → «rutracker пропадает». Срезаем.
    const cleanTitle = (movie.title || '').replace(/\s*(?:\([^)]*\)|\[[^\]]*\])+$/, '');
    const primaryQuery = cleanTitle || movie.original_title || '';
    const fallbackQuery =
      movie.original_title && movie.original_title !== movie.title
        ? movie.original_title
        : undefined;

    let cancelled = false;
    const mediaType = movie.media_type || 'movie';
    const id = movie.id;

    // ── Обогащение из TMDB (описание, рейтинг, актеры, кадры) — фоном, не блокирует UI ──
    // Числовой id (TMDB) берём напрямую; строковый (каталог HDRezka/Filmix) —
    // сначала ищем фильм по названию+году, чтобы добрать рейтинг и описание
    // (иначе в избранном «0.0», а в описании «Описание недоступно»).
    const enrichFromTmdb = async (): Promise<Movie | null> => {
      try {
        if (typeof id === 'number') {
          return await tmdbService.getMovieDetails(id, mediaType);
        }
        const found = await tmdbService.searchMovies(String(primaryQuery || movie.title || ''));
        const match =
          found.find((f) => year && String(extractYear(f.release_date)) === String(year)) ||
          found[0];
        if (!match) return null;
        return await tmdbService.getMovieDetails(match.id, match.media_type || mediaType);
      } catch {
        return null; /* карточка уже на экране — не критично */
      }
    };
    enrichFromTmdb().then((enriched) => {
      if (!cancelled && enriched) setDetails({ ...movie, ...enriched, id });
      // Страховка для Истории/Избранного: в записях библиотеки нет
      // original_title (подставлен = title) → EN-проход RuTracker не
      // запускался, а 4К-рипы на rutracker часто названы ТОЛЬКО латиницей.
      // Берём оригинал из TMDB и догоняем поиск — иначе «rutracker
      // пропадает» при открытии фильмов из личной библиотеки.
      const orig = enriched?.original_title;
      if (!cancelled && orig && orig !== primaryQuery && !fallbackQuery) {
        console.log(`[MovieDetailsModal] EN-догонка RuTracker: "${orig}"`);
        torrServerService
          .searchRutrackerLate(primaryQuery, year, orig)
          .then(({ releases: late }) => {
            if (cancelled || late.length === 0) return;
            setReleases((prev) => mergeReleasesByHash(prev, late));
          })
          .catch(() => {});
      }
    });

    // ── 1) VK Video: прямые HLS-потоки (Lampa-style, без TorrServer) ──
    searchVkVideo(`${primaryQuery}${year ? ' ' + year : ''}`.trim())
      .then((items) => {
        if (cancelled) return;
        setVkItems(items);
      })
      .catch((err: any) => {
        if (cancelled) return;
        console.warn('[MovieDetailsModal] VK Video search failed:', err?.message || err);
      })
      .finally(() => {
        if (!cancelled) setIsSearchingVk(false);
      });

    // ── 1b) Онлайн-потоки (KinoBox по KP-ID / Kodik по TMDB-ID) — параллельно
    //       с торрентами, не блокирует список. Торренты остаются главным
    //       источником: онлайн-список просто появляется ниже при наличии. ──
    searchOnlineStreams({
      // KinoBox принимает Кинопоиск-ID; в каталоге TMDB его нет, поэтому
      // KinoBox используется при наличии внешнего KP-ID, Kodik — по TMDB-ID
      // (movie.id) или названию+году (аниме/сериалы).
      kinopoiskId: undefined,
      tmdbId: typeof movie.id === 'number' ? movie.id : Number(movie.id) || undefined,
      title: primaryQuery,
      year,
    })
      .then((items) => {
        if (cancelled) return;
        setOnlineStreams(items);
      })
      .catch((err: any) => {
        if (cancelled) return;
        console.warn('[MovieDetailsModal] Online streams search failed:', err?.message || err);
      })
      .finally(() => {
        if (!cancelled) setIsSearchingOnline(false);
      });

    // ── 2) Торренты через TorrServer / JacRed (on-demand) ──
    torrServerService
      .searchTorrents(primaryQuery, year, undefined, undefined, undefined, fallbackQuery)
      .then(({ releases, error }) => {
        if (cancelled) return;
        // МЁРЖ с уже пришедшим RuTracker (не перезапись!): кэш браузерной
        // сессии отвечает мгновенно — раньше быстрый поиск (2-8с) стирал
        // смёрженные rutracker-строки → «RuTracker раз через раз пропадает».
        console.log(
          `[MovieDetailsModal] быстрый поиск: ${releases.length} раздач` +
            (releases.length === 0 ? ', error: ' + (error || '—') : '')
        );
        setReleases((prev) => mergeReleasesByHash(releases, prev));
        setSearchError(error || null);
        setIsScraping(false);
        if (error) {
          toastBus.push(error, 'error');
        }
        // Префетч: тихо добавляем лучшую раздачу в TorrServer, чтобы «Смотреть»
        // было мгновенным (метаданные + кэш буфера уже готовы при клике).
        if (releases.length > 0 && !cancelled) {
          torrServerService.prefetch(releases[0]).catch(() => {});
        }
      })
      .catch((err: any) => {
        if (cancelled) return;
        console.error('[MovieDetailsModal] Torrent search failed:', err);
        // RuTracker мог успеть ответить — не стираем уже пришедшие раздачи
        setReleases((prev) => prev);
        const msg = 'Не удалось выполнить поиск торрентов. Запустите TorrServer или проверьте соединение.';
        setSearchError(msg);
        setIsScraping(false);
        toastBus.push(msg, 'error');
      });

    // ── 3) RuTracker (браузерная сессия) — фоном, обычно 6-15с. ──
    // Не блокирует список: раздачи мёржатся реактивно, когда готовы —
    // раньше этот путь обрезался дедлайном 8с и раздачи «пропадали».
    setIsRutrackerSearching(true);
    torrServerService
      .searchRutrackerLate(primaryQuery, year, fallbackQuery)
      .then(({ releases: late }) => {
        if (cancelled) return;
        if (late.length > 0) {
          console.log(`[MovieDetailsModal] RuTracker догрузил ${late.length} раздач — мёржаем`);
          setReleases((prev) => mergeReleasesByHash(prev, late));
          setIsScraping(false);
        }
      })
      .catch((err: any) => {
        if (cancelled) return;
        console.warn('[MovieDetailsModal] RuTracker late search failed:', err?.message || err);
      })
      .finally(() => {
        if (!cancelled) setIsRutrackerSearching(false);
      });

    // ── Safety: жёсткий сброс скелетона через 8 с, даже если сервис завис ──
    const skeletonTimer = setTimeout(() => {
      if (!cancelled) setIsScraping(false);
    }, 8000);

    return () => {
      cancelled = true;
      clearTimeout(skeletonTimer);
    };
  }, [movie, searchNonce]);

  /** Воспроизвести раздачу (с опциональным сезоном/серией/таймкодом). */
  const playRelease = useCallback((
    release: TorrentRelease,
    opts?: { season?: number; episode?: number; startPosition?: number }
  ) => {
    // Сериалы: «Следующая серия» на энд-скрине плеера — ищем раздачу следующего
    // эпизода. Для сезонных паков это та же раздача, но с новым S/E.
    const hasEp = opts?.season != null && opts?.episode != null;
    const nextRel = hasEp ? findRelease(releases, opts.season!, opts.episode! + 1) : null;
    onPlayTorrent({
      magnet: release.magnet,
      title: `${movie.title} (${release.quality})`,
      poster: posterUrl,
      // .torrent-файл (rutracker) — надёжнее магнета для TorrServer
      torrentFile: release.torrentFile,
      // Кодеки раздачи — плеер решает: играть или предложить VLC/IINA
      videoCodec: release.videoCodec,
      audioCodec: release.audioCodec,
      season: opts?.season,
      episode: opts?.episode,
      nextEpisode:
        hasEp && nextRel
          ? { season: opts.season!, episode: opts.episode! + 1 }
          : null,
      onPlayNext:
        hasEp && nextRel
          ? () => playRelease(nextRel, { season: opts.season!, episode: opts.episode! + 1 })
          : undefined,
      startPosition: opts?.startPosition,
    });
  }, [movie, onPlayTorrent, posterUrl, releases]);

  /**
   * Клик по раздаче СЕРИАЛА: если в истории есть прогресс эпизодов — показываем
   * умное меню запуска (Продолжить / Следующая серия / Выбрать серию) вместо
   * немедленного воспроизведения. Фильмы играются сразу.
   */
  const handlePlayRelease = useCallback((
    release: TorrentRelease,
    opts?: { season?: number; episode?: number; startPosition?: number }
  ) => {
    if (movie.media_type === 'tv' && !opts) {
      const meta = parseTorrentMeta(release.title);
      const latest = histItems.find(
        (h) => h.id === String(movie.id) && h.season != null && h.episode != null
      );
      if (latest) {
        setEpisodeUi({ release, historyItem: latest, initialView: 'dialog' });
        return;
      }
      // История без эпизодов, но раздачи с S/E — сразу открываем пикер серий
      if (meta.seasons != null || meta.episodes != null) {
        setEpisodeUi({ release, historyItem: undefined, initialView: 'picker' });
        return;
      }
    }
    playRelease(release, opts);
  }, [movie, histItems, playRelease]);

  /** Воспроизвести вариант (озвучка · качество) из карточки онлайн-секции. */
  const playVariant = (v: OnlineVariant, card: OnlineCard) => {
    setPendingStream(null);
    if (card.sourceTone === 'vk') {
      const url = v.hlsUrl || v.mp4Url;
      if (!url) {
        toastBus.push('У этого VK-видео не удалось получить поток', 'error');
        return;
      }
      onPlayTorrent({
        magnet: '',
        title: `${movie.title} [VK ${v.quality}${v.dubbing ? ' · ' + v.dubbing : ''}]`,
        poster: posterUrl,
        directUrl: url,
        directQuality: v.quality,
      });
      return;
    }
    // Балансер: прямой .m3u8 в Hls.js (с Referer CDN); иначе iframe в браузере.
    if (v.m3u8Url) {
      onPlayTorrent({
        magnet: '',
        title: `${movie.title} [${card.sourceLabel} ${v.quality}${v.dubbing ? ' · ' + v.dubbing : ''}]`,
        poster: posterUrl,
        directUrl: v.m3u8Url,
        directQuality: v.quality,
        directReferer: v.referer || 'https://kinobox.tv/',
      });
      return;
    }
    if (v.iframeUrl) {
      window.electronAPI?.openExternal?.(v.iframeUrl);
      return;
    }
    toastBus.push('У этого потока не удалось получить ссылку воспроизведения', 'error');
  };

  /** Клик по карточке онлайн-потока: одна озвучка — играем сразу,
   *  несколько — диалог выбора озвучки перед началом просмотра. */
  const playStreamCard = (card: OnlineCard) => {
    if (card.variants.length === 1) {
      playVariant(card.variants[0], card);
      return;
    }
    setPendingStream(card);
  };

  /** Единый список «Онлайн»: VK-группы (по фильму) + балансеры (по источнику). */
  const onlineCards = useMemo<OnlineCard[]>(() => {
    const cards: OnlineCard[] = [];
    const vkGroups = new Map<string, VkVideoItem[]>();
    for (const it of vkItems) {
      const k = normalizeVkTitle(it.title);
      const list = vkGroups.get(k) || [];
      list.push(it);
      vkGroups.set(k, list);
    }
    for (const [, list] of vkGroups) {
      cards.push({
        key: `vk-${normalizeVkTitle(list[0].title)}`,
        sourceLabel: 'VK',
        sourceTone: 'vk',
        title: cleanStreamTitle(list[0].title),
        variants: [...list]
          .sort(
            (a, b) =>
              (b.dubbing ? 1 : 0) - (a.dubbing ? 1 : 0) ||
              qualityRank(a.quality) - qualityRank(b.quality)
          )
          .map((it) => ({
            key: it.id,
            dubbing: it.dubbing,
            quality: it.quality,
            duration: it.duration,
            hlsUrl: it.hlsUrl,
            mp4Url: it.mp4Url,
          })),
      });
    }
    const balGroups = new Map<string, OnlineBalancerStream[]>();
    for (const s of onlineStreams) {
      const list = balGroups.get(s.source) || [];
      list.push(s);
      balGroups.set(s.source, list);
    }
    for (const [source, list] of balGroups) {
      cards.push({
        key: `bal-${source}`,
        sourceLabel: source,
        sourceTone: 'balancer',
        title: movie.title || movie.name || 'Онлайн-поток',
        variants: [...list]
          .sort((a, b) => qualityRank(a.quality) - qualityRank(b.quality))
          .map((s) => ({
            key: s.id,
            dubbing: s.translation && s.translation !== 'Не указано' ? s.translation : undefined,
            quality: s.quality,
            m3u8Url: s.m3u8Url,
            referer: s.referer,
            iframeUrl: s.iframeUrl,
          })),
      });
    }
    return cards;
  }, [vkItems, onlineStreams, movie]);

  return (
    <div
      ref={modalRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        background: 'rgba(0,0,0,0.9)',
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
          background: 'rgba(11,12,17,0.985)',
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
            background: 'rgba(10,11,14,0.9)',
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
                src={posterSrc}
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
                onError={e => {
                  const img = e.currentTarget as HTMLImageElement;
                  if (img.src === posterPlaceholder) return; // уже заглушка
                  img.src = posterPlaceholder;
                  img.style.display = 'block';
                }}
              />

              {/* Text Meta */}
              <div style={{ flex: 1 }}>
                {/* Badges */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem', flexWrap: 'wrap' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '3px', padding: '3px 9px', borderRadius: '999px', background: 'rgba(255,184,0,0.15)', border: '1px solid rgba(255,184,0,0.4)', color: '#FFB800', fontSize: '0.75rem', fontWeight: 800, boxShadow: '0 0 10px rgba(255,184,0,0.2)' }}>
                    <Star size={11} fill="#FFB800" />
                    {(m.vote_average || movie.vote_average || 0) > 0
                      ? (m.vote_average || movie.vote_average || 0).toFixed(1)
                      : '—'}
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
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <Bookmark size={13} fill={isLater ? '#00F2FE' : 'none'} />
                    {isLater ? 'В списке' : 'Позже'}
                  </button>
                </div>

                {/* Title */}
                <h1 style={{ fontSize: 'clamp(1.4rem, 3vw, 2.2rem)', fontWeight: 900, color: '#fff', letterSpacing: '-0.02em', lineHeight: 1.1, marginBottom: '0.3rem', textShadow: '0 2px 12px rgba(0,0,0,0.8)' }}>
                  {m.title || m.name}
                </h1>

                {m.original_title && m.original_title !== m.title && (
                  <p style={{ fontSize: '0.82rem', color: 'rgba(0,242,254,0.5)', fontWeight: 600 }}>{m.original_title}</p>
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
                {m.overview || 'Описание недоступно.'}
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

            {/* ── Онлайн: VK + Kodik + балансеры в едином списке с подписями ──
                Каждая карточка = источник + фильм; внутри — озвучки (чипы).
                Клик: одна озвучка → сразу просмотр, несколько → диалог выбора. */}
            {(isSearchingVk || isSearchingOnline || onlineCards.length > 0) && (
            <div
              style={{
                marginBottom: '1rem',
                background: 'rgba(14,15,21,0.93)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: '22px',
                overflow: 'hidden',
              }}
            >
              <div
                onClick={() => setIsOnlineOpen((o) => !o)}
                onKeyDown={(e) => keyActivate(e, () => setIsOnlineOpen((o) => !o))}
                tabIndex={0}
                role="button"
                aria-expanded={isOnlineOpen}
                title={isOnlineOpen ? 'Свернуть онлайн-потоки' : 'Развернуть онлайн-потоки'}
                style={{
                  padding: '1.2rem 1.4rem 1rem',
                  borderBottom: isOnlineOpen ? '1px solid rgba(255,255,255,0.05)' : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.65rem',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <div
                  style={{
                    width: '34px',
                    height: '34px',
                    borderRadius: '10px',
                    background: 'linear-gradient(135deg, rgba(0,198,251,0.18), rgba(138,43,226,0.14))',
                    border: '1px solid rgba(0,242,254,0.22)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Radio size={16} style={{ color: 'var(--cyan)' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                    Онлайн
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                    VK · Kodik · балансеры · без TorrServer
                  </div>
                </div>
                {onlineCards.length > 0 && (
                  <span
                    style={{
                      padding: '2px 8px',
                      borderRadius: '999px',
                      background: 'rgba(0,242,254,0.12)',
                      border: '1px solid rgba(0,242,254,0.3)',
                      color: 'var(--cyan)',
                      fontSize: '0.7rem',
                      fontWeight: 800,
                      flexShrink: 0,
                    }}
                  >
                    {onlineCards.length}
                  </span>
                )}
                <span style={{ flexShrink: 0, color: 'var(--text-muted)', display: 'flex' }}>
                  {isOnlineOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </span>
              </div>

              {isOnlineOpen && (
                <div style={{ padding: '0.8rem 1.4rem 1.1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {isSearchingVk || isSearchingOnline ? (
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      {[1, 2, 3].map((n) => (
                        <div key={n} className="skeleton" style={{ width: '180px', height: '40px', borderRadius: '10px' }} />
                      ))}
                    </div>
                  ) : onlineCards.length === 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      <Radio size={14} />
                      Онлайн-потоки не найдены — используйте торренты ниже
                    </div>
                  ) : (
                    onlineCards.map((card) => (
                      <button
                        key={card.key}
                        onClick={() => playStreamCard(card)}
                        title={`Выбрать поток: ${card.sourceLabel} · ${card.title}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.6rem',
                          padding: '0.55rem 0.9rem',
                          borderRadius: '12px',
                          background: 'rgba(255,255,255,0.025)',
                          border: '1px solid rgba(255,255,255,0.06)',
                          color: 'var(--text-primary)',
                          fontFamily: 'inherit',
                          cursor: 'pointer',
                          transition: 'all 0.2s ease',
                          textAlign: 'left',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(0,242,254,0.07)';
                          e.currentTarget.style.borderColor = 'rgba(0,242,254,0.28)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'rgba(255,255,255,0.025)';
                          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)';
                        }}
                      >
                        {/* Источник */}
                        <span
                          style={{
                            flexShrink: 0,
                            padding: '2px 8px',
                            borderRadius: '6px',
                            fontSize: '0.64rem',
                            fontWeight: 900,
                            letterSpacing: '0.05em',
                            maxWidth: '110px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            ...(card.sourceTone === 'vk'
                              ? { background: 'rgba(0,242,254,0.12)', color: '#00F2FE', border: '1px solid rgba(0,242,254,0.3)' }
                              : { background: 'rgba(138,43,226,0.12)', color: '#C9A2FF', border: '1px solid rgba(138,43,226,0.35)' }),
                          }}
                        >
                          {card.sourceLabel}
                        </span>
                        {/* Качество лучшего варианта */}
                        <span
                          style={{
                            flexShrink: 0,
                            padding: '2px 7px',
                            borderRadius: '6px',
                            fontSize: '0.64rem',
                            fontWeight: 900,
                            letterSpacing: '0.05em',
                            background: card.variants[0].quality === '4K'
                              ? 'rgba(255,184,0,0.14)'
                              : card.variants[0].quality === '1080p'
                              ? 'rgba(0,242,254,0.12)'
                              : card.variants[0].quality === '720p'
                              ? 'rgba(16,245,172,0.12)'
                              : 'rgba(255,255,255,0.07)',
                            color: card.variants[0].quality === '4K' ? '#FFB800' : card.variants[0].quality === '1080p' ? '#00F2FE' : card.variants[0].quality === '720p' ? '#10F5AC' : 'rgba(240,242,248,0.55)',
                            border: `1px solid ${card.variants[0].quality === '4K' ? 'rgba(255,184,0,0.4)' : card.variants[0].quality === '1080p' ? 'rgba(0,242,254,0.35)' : card.variants[0].quality === '720p' ? 'rgba(16,245,172,0.3)' : 'rgba(255,255,255,0.1)'}`,
                          }}
                        >
                          {card.variants[0].quality}
                        </span>
                        {/* Название */}
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.8rem', fontWeight: 600 }}>
                          {card.title}
                        </span>
                        {/* Доступные озвучки (чипы) */}
                        <span style={{ display: 'flex', gap: '4px', flexShrink: 0, alignItems: 'center' }}>
                          {card.variants.slice(0, 3).map((v) => (
                            <span
                              key={v.key}
                              style={{
                                padding: '1px 7px',
                                borderRadius: '999px',
                                fontSize: '0.62rem',
                                fontWeight: 700,
                                background: 'rgba(76,195,138,0.1)',
                                color: '#6FD6A2',
                                border: '1px solid rgba(76,195,138,0.26)',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {v.dubbing || 'Оригинал'}
                            </span>
                          ))}
                          {card.variants.length > 3 && (
                            <span style={{ fontSize: '0.62rem', fontWeight: 800, color: 'var(--text-muted)' }}>
                              +{card.variants.length - 3}
                            </span>
                          )}
                        </span>
                        {/* Длительность (VK) */}
                        {card.sourceTone === 'vk' && card.variants[0].duration ? (
                          <span style={{ flexShrink: 0, fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                            {formatClock(card.variants[0].duration)}
                          </span>
                        ) : null}
                        <span
                          style={{
                            flexShrink: 0,
                            width: '34px',
                            height: '34px',
                            borderRadius: '10px',
                            background: 'linear-gradient(135deg, rgba(0,198,251,0.2), rgba(138,43,226,0.2))',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Play size={13} fill="white" style={{ color: '#fff', marginLeft: '1px' }} />
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            )}

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
            {/* JacRed-источники восстанавливаются в фоне автоматически
                (динамический пул + racing probe) — плашка не требуется. */}
            {/* Серии: умный выбор эпизода (для сериалов) */}
            {movie.media_type === 'tv' && releases.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.75rem' }}>
                <button
                  onClick={() => setEpisodeUi({ release: releases[0], historyItem: undefined, initialView: 'picker' })}
                  className="btn-secondary"
                  style={{ borderRadius: '10px', padding: '0.45rem 1rem', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                >
                  <Tv size={13} style={{ color: 'var(--cyan)' }} />
                  Выбрать серию
                </button>
              </div>
            )}
            <TorrentSelector
              releases={releases}
              isLoading={isScraping}
              onPlayRelease={handlePlayRelease}
              onRetry={() => setSearchNonce((n) => n + 1)}
              error={searchError}
              isRutrackerSearching={isRutrackerSearching}
              tvSeasons={tvSeasons}
              seasonFilter={seasonFilter}
              onSeasonFilterChange={(s) => {
                setSeasonFilter(s);
                if (s > 0 && movie.media_type === 'tv' && window.electronAPI?.rutrackerSearch) {
                  // Сезон выбран — ищем RuTracker-раздачи именно этого сезона
                  // (темы вида «Название [S01]»); результат домёржится в список.
                  const baseQ = (movie.title || movie.original_title || '').replace(
                    /\s*(?:\([^)]*\)|\[[^\]]*\])+$/,
                    ''
                  );
                  const q = `${baseQ} S${String(s).padStart(2, '0')}`;
                  torrServerService.searchRutrackerLate(q, year).then(({ releases: late }) => {
                    if (!isMountedRef.current || late.length === 0) return;
                    setReleases((prev) => mergeReleasesByHash(prev, late));
                  }).catch(() => {});
                }
              }}
            />

          </div>
        </div>
      </div>
      {pendingStream && (
        <div
          onClick={() => setPendingStream(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 70,
            background: 'rgba(0,0,0,0.72)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1.5rem',
            animation: 'fadeIn 0.15s ease',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: '460px',
              background: 'rgba(16,18,26,0.98)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '20px',
              overflow: 'hidden',
              boxShadow: '0 24px 70px rgba(0,0,0,0.7)',
            }}
          >
            <div style={{ padding: '1.1rem 1.3rem 0.9rem', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'flex-start', gap: '0.6rem' }}>
              <span
                style={{
                  flexShrink: 0,
                  padding: '2px 8px',
                  borderRadius: '6px',
                  fontSize: '0.64rem',
                  fontWeight: 900,
                  letterSpacing: '0.05em',
                  marginTop: '2px',
                  ...(pendingStream.sourceTone === 'vk'
                    ? { background: 'rgba(0,242,254,0.12)', color: '#00F2FE', border: '1px solid rgba(0,242,254,0.3)' }
                    : { background: 'rgba(138,43,226,0.12)', color: '#C9A2FF', border: '1px solid rgba(138,43,226,0.35)' }),
                }}
              >
                {pendingStream.sourceLabel}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.3 }}>{pendingStream.title}</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '2px' }}>Выберите озвучку</div>
              </div>
              <button
                onClick={() => setPendingStream(null)}
                aria-label="Закрыть"
                style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px', flexShrink: 0 }}
              >
                <X size={16} />
              </button>
            </div>
            <div style={{ padding: '0.8rem 1.3rem 1.2rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
              {pendingStream.variants.map((v) => (
                <button
                  key={v.key}
                  onClick={() => playVariant(v, pendingStream)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                    padding: '0.6rem 0.9rem',
                    borderRadius: '12px',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: 'var(--text-primary)',
                    fontFamily: 'inherit',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(0,242,254,0.08)';
                    e.currentTarget.style.borderColor = 'rgba(0,242,254,0.3)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
                  }}
                >
                  <span style={{ padding: '1px 8px', borderRadius: '999px', fontSize: '0.64rem', fontWeight: 800, background: 'rgba(76,195,138,0.12)', color: '#6FD6A2', border: '1px solid rgba(76,195,138,0.3)', flexShrink: 0 }}>
                    {v.dubbing || 'Оригинал'}
                  </span>
                  <span style={{ padding: '1px 7px', borderRadius: '6px', fontSize: '0.64rem', fontWeight: 900, background: 'rgba(255,255,255,0.07)', color: 'rgba(240,242,248,0.6)', border: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 }}>
                    {v.quality}
                  </span>
                  {v.duration ? (
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600, marginLeft: 'auto' }}>{formatClock(v.duration)}</span>
                  ) : (
                    <span style={{ marginLeft: 'auto' }} />
                  )}
                  <Play size={14} fill="white" style={{ color: '#fff', flexShrink: 0 }} />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {episodeUi && (
        <EpisodeResumeDialog
          movie={movie}
          release={episodeUi.release}
          historyItem={episodeUi.historyItem}
          releases={releases}
          tmdbSeasons={tmdbSeasons}
          onPlay={(rel, opts) => {
            setEpisodeUi(null);
            playRelease(rel, opts);
          }}
          onClose={() => setEpisodeUi(null)}
        />
      )}
    </div>
  );
};
