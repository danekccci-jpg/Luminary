import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  X, Play, Pause, Volume2, VolumeX,
  Maximize, Minimize, Zap, Users,
  AlertTriangle, SkipBack, SkipForward,
  SlidersHorizontal, Sun, Contrast, Palette, Monitor,
  ExternalLink, Loader2, MonitorPlay, RotateCcw, PictureInPicture2, Gauge, Subtitles, AudioLines, Check, ChevronDown, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { TorrServerStats } from '../types';
import { torrServerService } from '../services/torrserver';
import { toastBus } from '../services/toast';
import { probeAudioTracks, audioTrackLabel as mkvTrackLabel, StreamAudioTrack } from '../services/streamTracks';
// Hls.js — воспроизведение HLS (/gst/master.m3u8 от TorrServer MatriX.gst):
// автоматический транскодинг HEVC/H.265, AC3/DTS/TrueHD, 10-bit MKV → MSE.
// (Chromium не умеет эти кодеки нативно, но умеет их декодировать через MSE.)
import Hls from 'hls.js';
import { registerBackHandler } from '../utils/tv';

interface PlayerModalProps {
  magnet: string;
  title: string;
  poster?: string;
  /** Prefer AAC/MP3 track or GST HLS remux for AC3/DTS */
  audioCodec?: string;
  videoCodec?: string;
  transcodeAudioToAac?: boolean;
  /** Прямой HLS/MP4 поток (VK Video) — играем без TorrServer и GStreamer:
   *  .m3u8 уходит в Hls.js, mp4 — в нативный <video>. */
  directUrl?: string;
  /** Referer для CDN прямого потока (онлайн-балансеры kinobox/alloha и т.д.) —
   *  ставится в Hls.js xhrSetup + в сетевой перехватчик Electron (для mp4). */
  directReferer?: string;
  /** .torrent-файл (base64) — добавляем в TorrServer вместо магнета (rutracker). */
  torrentFile?: string;
  /** Ярлык качества из источника (онлайн: VK/kinobox) — до парсинга манифеста. */
  directQuality?: string;
  /** Следующая серия (S/E) — кнопка «Следующая серия» на энд-скрине (сериалы). */
  nextEpisode?: { season: number; episode: number } | null;
  /** Запустить следующую серию (пересобирает стрим через каталог). */
  onPlayNext?: () => void;
  /** Сохранение прогресса просмотра (история) при закрытии/завершении. */
  onProgressSave?: (current: number, duration: number) => void;
  /** Возобновить просмотр с этого таймкода (из истории). */
  startPosition?: number;
  onClose: () => void;
  /** TV-режим (пульт): ArrowUp/Down переходят в панели контролов вместо громкости. */
  tvMode?: boolean;
}

/** Максимум попыток проверки HTTP 200 потока (1.5s интервал → ~45s). */
const MAX_PROBE_ATTEMPTS = 30;
/** Сколько ждать начала воспроизведения после монтирования <video>. */
const START_TIMEOUT_MS = 5000;

// ── Video Filter Preset ──
interface VideoFilters {
  brightness: number;  // 0.5 – 1.5 (default 1)
  contrast: number;    // 0.5 – 1.5 (default 1)
  saturation: number;  // 0.0 – 2.0 (default 1)
  grayscale: boolean;
  aspectRatio: 'contain' | 'cover' | 'fill' | '16:9' | '21:9' | '4:3';
}

const DEFAULT_FILTERS: VideoFilters = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  grayscale: false,
  aspectRatio: 'contain',
};

const FILTER_STORAGE_KEY = 'luminary_video_filters';

function loadSavedFilters(): VideoFilters {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const asp = parsed.aspectRatio === 'fit' ? 'contain' : parsed.aspectRatio === 'fill' ? 'cover' : parsed.aspectRatio;
      return { ...DEFAULT_FILTERS, ...parsed, aspectRatio: asp };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_FILTERS };
}

function saveFilters(filters: VideoFilters) {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
  } catch { /* ignore */ }
}

// ── Сохранённое качество (онлайн-режим) ──
const QUALITY_STORAGE_KEY = 'luminary_hls_quality';
function loadSavedQuality(): string {
  try { return localStorage.getItem(QUALITY_STORAGE_KEY) || 'auto'; } catch { return 'auto'; }
}
function saveSavedQuality(value: string) {
  try { localStorage.setItem(QUALITY_STORAGE_KEY, value); } catch { /* ignore */ }
}

// ── Filter Slider sub-component ──
const FilterSlider: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}> = ({ icon, label, value, min, max, step, onChange }) => {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style={{ color: 'var(--text-muted)', display: 'flex' }}>{icon}</span>
          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</span>
        </div>
        <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--cyan)' }}>
          {Math.round(value * 100)}%
        </span>
      </div>
      <div style={{ position: 'relative', height: '20px', display: 'flex', alignItems: 'center' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, height: '4px', background: 'rgba(255,255,255,0.08)', borderRadius: '99px' }}>
          <div style={{
            width: `${pct}%`,
            height: '100%',
            background: 'linear-gradient(90deg, #00F2FE, #8A2BE2)',
            borderRadius: '99px',
            boxShadow: '0 0 6px rgba(0,242,254,0.4)',
            transition: 'width 0.15s ease',
          }} />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
          className="neon-slider"
          style={{ position: 'absolute', left: 0, right: 0, opacity: 0.01, width: '100%', cursor: 'pointer' }}
        />
      </div>
    </div>
  );
};

/** Pick Chromium-compatible audio track (AAC / MP3 / Opus) when AudioTrackList is available. */
function selectCompatibleAudioTrack(video: HTMLVideoElement): string | null {
  const list = (video as any).audioTracks as
    | { length: number; [i: number]: { enabled: boolean; language?: string; label?: string; kind?: string; id?: string } }
    | undefined;
  if (!list || list.length === 0) return null;

  const prefer = /aac|mp3|mp4a|opus|vorbis|flac|pcm|mpeg|lc-aac|he-aac/i;
  const avoid = /ac-?3|eac-?3|ec-?3|dts|truehd|atmos|mlp/i;

  let bestIdx = -1;
  for (let i = 0; i < list.length; i++) {
    const meta = `${list[i].label || ''} ${list[i].language || ''} ${list[i].kind || ''} ${list[i].id || ''}`;
    if (prefer.test(meta)) {
      bestIdx = i;
      break;
    }
    if (!avoid.test(meta) && bestIdx < 0) bestIdx = i;
  }
  if (bestIdx < 0) bestIdx = 0;

  for (let i = 0; i < list.length; i++) {
    list[i].enabled = i === bestIdx;
  }
  const chosen = list[bestIdx];
  return chosen?.label || chosen?.language || `track-${bestIdx}`;
}

// ── Futuristic Neon Ring Spinner (moved outside component for clarity) ──
const NeonRingSpinner: React.FC<{ percent: number }> = ({ percent: raw }) => {
  const percent = Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 0));
  const r1 = 70, r2 = 56, r3 = 44;
  const c1 = 2 * Math.PI * r1;
  const c2 = 2 * Math.PI * r2;
  const c3 = 2 * Math.PI * r3;

  return (
    <div style={{ position: 'relative', width: '180px', height: '180px' }}>
      <svg
        width="180"
        height="180"
        viewBox="0 0 180 180"
        style={{ position: 'absolute', top: 0, left: 0 }}
      >
        {/* Outer glow ring - track */}
        <circle cx="90" cy="90" r={r1} fill="none" stroke="rgba(0,242,254,0.06)" strokeWidth="3" />
        {/* Outer progress arc - CYAN */}
        <circle
          cx="90" cy="90" r={r1}
          fill="none"
          stroke="url(#cyanGrad)"
          strokeWidth="3"
          strokeDasharray={c1}
          strokeDashoffset={c1 - (c1 * percent) / 100}
          strokeLinecap="round"
          style={{
            transformOrigin: '90px 90px',
            transform: 'rotate(-90deg)',
            filter: 'drop-shadow(0 0 8px rgba(0,242,254,0.8))',
            transition: 'stroke-dashoffset 0.5s ease',
          }}
        />

        {/* Mid ring - track */}
        <circle cx="90" cy="90" r={r2} fill="none" stroke="rgba(138,43,226,0.06)" strokeWidth="2.5" />
        {/* Mid progress arc - PURPLE */}
        <circle
          cx="90" cy="90" r={r2}
          fill="none"
          stroke="url(#purpleGrad)"
          strokeWidth="2.5"
          strokeDasharray={c2}
          strokeDashoffset={c2 - (c2 * Math.min(100, percent * 1.3)) / 100}
          strokeLinecap="round"
          style={{
            transformOrigin: '90px 90px',
            transform: 'rotate(-90deg)',
            filter: 'drop-shadow(0 0 6px rgba(138,43,226,0.7))',
            transition: 'stroke-dashoffset 0.6s ease 0.1s',
          }}
        />

        {/* Inner spinning ring */}
        <circle cx="90" cy="90" r={r3} fill="none" stroke="rgba(0,242,254,0.04)" strokeWidth="2" />
        <circle
          cx="90" cy="90" r={r3}
          fill="none"
          stroke="rgba(0,242,254,0.35)"
          strokeWidth="2"
          strokeDasharray={`${c3 * 0.15} ${c3 * 0.85}`}
          strokeLinecap="round"
          style={{
            transformOrigin: '90px 90px',
            animation: 'spin 1.5s linear infinite',
          }}
        />

        {/* Gradient Defs */}
        <defs>
          <linearGradient id="cyanGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#00F2FE" />
            <stop offset="100%" stopColor="#4facfe" />
          </linearGradient>
          <linearGradient id="purpleGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#8A2BE2" />
            <stop offset="100%" stopColor="#D946EF" />
          </linearGradient>
        </defs>
      </svg>

      {/* Center Percentage Text */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            fontSize: '2rem',
            fontWeight: 900,
            background: 'linear-gradient(135deg, #00F2FE, #8A2BE2)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            lineHeight: 1,
          }}
        >
          {percent}%
        </div>
        <div
          style={{
            fontSize: '0.6rem',
            color: 'rgba(0,242,254,0.5)',
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            marginTop: '4px',
          }}
        >
          Buffer
        </div>
      </div>
    </div>
  );
};

export const PlayerModal: React.FC<PlayerModalProps> = ({
  magnet, title, poster, audioCodec, videoCodec, transcodeAudioToAac = true, directUrl, directQuality, directReferer, torrentFile, nextEpisode, onPlayNext, onProgressSave, startPosition, onClose, tvMode = false,
}) => {
  const videoRef     = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressRef  = useRef<HTMLDivElement>(null);
  const controlsTimerRef = useRef<NodeJS.Timeout | null>(null);
  const preloadRef   = useRef<{ controller: AbortController | null }>({ controller: null });

  const [streamUrl, setStreamUrl]       = useState('');
  const [hash, setHash]                 = useState('');
  const [isBuffering, setIsBuffering]   = useState(true);
  const [bufferPercent, setBufPercent]  = useState(0);
  const [stats, setStats]               = useState<TorrServerStats | null>(null);

  const [isPlaying, setIsPlaying]       = useState(false);
  const [currentTime, setCurrentTime]   = useState(0);
  const [duration, setDuration]         = useState(0);
  const [buffered, setBuffered]         = useState(0);
  const [volume, setVolume]             = useState(1);
  const [isMuted, setIsMuted]           = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [errorMsg, setErrorMsg]         = useState('');
  const [audioTrackLabel, setAudioTrackLabel] = useState('');

  /** Онлайн-режим (VK/kinobox): directUrl есть — играем без TorrServer и GStreamer. */
  const isOnline = !!directUrl;

  // ── Онлайн-режим: «Подключение к источнику…» до первого playing ──
  const [onlineLoading, setOnlineLoading] = useState(false);

  // ── Качество (онлайн, Hls.js): уровни манифеста + текущий ──
  const [hlsLevels, setHlsLevels] = useState<Array<{ index: number; label: string }>>([]);
  const [currentLevel, setCurrentLevel] = useState(-1); // индекс уровня, -1 = ещё не выбран
  const [qualityAuto, setQualityAuto] = useState(true);
  const [showQuality, setShowQuality] = useState(false);
  const qualityRef = useRef<HTMLDivElement>(null);

  // ── Превью кадров на прогресс-баре (нативные потоки) ──
  const [scrubPreviewImg, setScrubPreviewImg] = useState<string | null>(null);
  const captureVideoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const scrubPreviewTimer = useRef<NodeJS.Timeout | null>(null);
  const captureSeqRef = useRef(0);

  // ── Панель параметров: страницы вместо одного развёрнутого списка ──
  const [filtersPage, setFiltersPage] = useState<'root' | 'image' | 'scale' | 'speed' | 'audio' | 'subs'>('root');
  const filtersPanelRef = useRef<HTMLDivElement>(null);

  // ── Буферизация / проверка потока ──
  const [streamReady, setStreamReady]   = useState(false);  // HTTP 200/206 от /stream получен
  const [skipRequested, setSkipRequested] = useState(false); // «Пропустить буферизацию» нажат
  const [containerExt, setContainerExt] = useState('');      // .mkv / .mp4 / .ts из file_stats
  const [codecError, setCodecError]     = useState(false);   // onError / 5s без воспроизведения
  /** Деталь последней медиа-ошибки (MEDIA_ERR_*) — для понятного сообщения в оверлее. */
  const [mediaErrorDetail, setMediaErrorDetail] = useState('');

  // ── Видео Фильтры ──
  const [filters, setFilters]       = useState<VideoFilters>(loadSavedFilters);
  const [showFilters, setShowFilters] = useState(false);

  // ── Новые возможности плеера ──
  const [volumeHud, setVolumeHud]   = useState<number | null>(null); // всплывающий индикатор громкости
  const [playbackRate, setPlaybackRate] = useState(1);
  const [audioTracks, setAudioTracks]   = useState<Array<{ index: number; label: string }>>([]);
  const [activeAudioTrack, setActiveAudioTrack] = useState(-1);
  /** Дорожки из MKV-контейнера (EBML-проба /stream) — языки + студии озвучки. */
  const [mkvTracks, setMkvTracks]       = useState<StreamAudioTrack[]>([]);
  const mkvProbeDoneRef = useRef(false);
  /** Позиция для seek'а после переключения аудиодорожки (поток пересобирается). */
  const seekOnLoadRef = useRef<number | null>(null);
  const [isPip, setIsPip]           = useState(false);
  const [isEnded, setIsEnded]       = useState(false);
  const [scrubHover, setScrubHover] = useState<{ x: number; time: number } | null>(null);
  // Актуальный видео-индекс (для фонового ретранскода AC3/DTS → AAC при сбое кодека)
  const videoIndexRef = useRef<number | undefined>(undefined);
  // Hls.js: инстанс для HLS-потока (/gst/master.m3u8) + флаг активного режима
  const hlsRef = useRef<Hls | null>(null);
  const [isHlsMode, setIsHlsMode] = useState(false);
  // Настройки субтитров (применяются к <track>, если поток их содержит)
  const [subs, setSubs] = useState({
    enabled: true,
    size: 100,        // % от стандартного
    color: '#FFFFFF',
    bgOpacity: 0.6,   // 0..1
    delay: 0,         // сек, +позже / −раньше
  });
  const volumeHudTimer = useRef<NodeJS.Timeout | null>(null);

  const showVolumeHud = (v: number) => {
    setVolumeHud(v);
    if (volumeHudTimer.current) clearTimeout(volumeHudTimer.current);
    volumeHudTimer.current = setTimeout(() => setVolumeHud(null), 1200);
  };

  // Persist filters to localStorage on change
  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  // Apply CSS filters directly to video element
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const { brightness, contrast, saturation, grayscale } = filters;
    const gs = grayscale ? 'grayscale(1)' : '';
    video.style.filter = `brightness(${brightness}) contrast(${contrast}) saturate(${saturation}) ${gs}`.trim();
    video.style.transition = 'filter 0.3s ease';
  }, [filters]);

  // Map aspectRatio to object-fit
  const objectFitStyle: React.CSSProperties = (() => {
    switch (filters.aspectRatio) {
      case 'cover': return { objectFit: 'cover' };
      case 'fill':  return { objectFit: 'fill' };
      case '16:9':  return { objectFit: 'contain', aspectRatio: '16/9' };
      case '21:9':  return { objectFit: 'contain', aspectRatio: '21/9' };
      case '4:3':   return { objectFit: 'contain', aspectRatio: '4/3' };
      default:      return { objectFit: 'contain' };
    }
  })();

  // Скорость воспроизведения → video.playbackRate
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  // Применение настроек субтитров к <track>-элементам видео
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const tracks = Array.from(video.textTracks || []);
    for (const tr of tracks) {
      tr.mode = subs.enabled ? 'showing' : 'hidden';
    }
    // Стилизация через CSS-переменные на видео (WebVTT ку-стили не поддерживаются
    // нативно, поэтому применяем глобальные стили cue)
    video.style.setProperty('--sub-size', `${subs.size}%`);
    video.style.setProperty('--sub-color', subs.color);
    video.style.setProperty('--sub-bg-opacity', String(subs.bgOpacity));
  }, [subs]);

  // Глобальные стили cue (WebVTT): размер/цвет/фон через ::cue
  useEffect(() => {
    const styleId = 'luminary-cue-styles';
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `
      video::cue {
        font-size: var(--sub-size, 100%) !important;
        color: var(--sub-color, #fff) !important;
        background: rgba(0,0,0,var(--sub-bg-opacity, 0.6)) !important;
      }`;
  }, []);

  // Сбор аудио-дорожек из video.audioTracks (multitrack hls/mkv)
  const collectAudioTracks = () => {
    const video = videoRef.current;
    if (!video) return;
    const list = (video as any).audioTracks as
      | { length: number; [i: number]: { enabled: boolean; label?: string; language?: string; id?: string } }
      | undefined;
    if (!list || list.length === 0) return;
    const arr: Array<{ index: number; label: string }> = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      arr.push({ index: i, label: (t.label || t.language || `Дорожка ${i + 1}`).trim() || `Дорожка ${i + 1}` });
    }
    setAudioTracks(arr);
    let active = 0;
    for (let i = 0; i < list.length; i++) { if (list[i].enabled) { active = i; break; } }
    setActiveAudioTrack(active);
  };

  const selectAudioTrack = (index: number) => {
    // MKV-контейнер: дорожки из EBML-пробы (языки + студии озвучки) — пробрасываем
    // выбранный audio_index в поток TorrServer gst (`audio=N` → транскод этой дорожки).
    // Позиция воспроизведения НЕ сбрасывается: seek возвращается после загрузки потока.
    if (mkvTracks.length > 1) {
      if (!hash || !videoIndexRef.current) return;
      const label = mkvTrackLabel(mkvTracks[index]);
      const video = videoRef.current;
      const savedTime = video && Number.isFinite(video.currentTime) && video.currentTime > 0 ? video.currentTime : 0;
      torrServerService
        .getStreamUrl(hash, videoIndexRef.current, true, index)
        .then((gstUrl) => {
          if (!gstUrl) return;
          setActiveAudioTrack(index);
          setAudioTrackLabel(label);
          setShowControls(true);
          if (gstUrl !== streamUrl) {
            if (savedTime > 0) seekOnLoadRef.current = savedTime; // вернёмся на позицию
            console.warn(
              `[Player] MKV audio → дорожка ${index + 1} (${label}), gst audio=${index}` +
                (savedTime > 0 ? `, позиция ${Math.round(savedTime)}с сохранится` : '')
            );
            setStreamUrl(gstUrl);
            toastBus.push(`Аудио: ${label}`, 'info');
          }
        })
        .catch(() => {});
      return;
    }
    // HLS-режим (Hls.js): переключение через hls.audioTrack (gst отдаёт дорожки в манифесте)
    const hls = hlsRef.current;
    if (hls && isHlsMode) {
      const t = hls.audioTracks[index];
      if (!t) return;
      hls.audioTrack = index;
      setActiveAudioTrack(index);
      setAudioTrackLabel(t.name || `Дорожка ${index + 1}`);
      setShowControls(true);
      return;
    }
    const video = videoRef.current;
    const list = (video as any)?.audioTracks as { length: number; [i: number]: { enabled: boolean; label?: string } } | undefined;
    if (!list || index < 0 || index >= list.length) return;
    for (let i = 0; i < list.length; i++) list[i].enabled = i === index;
    setActiveAudioTrack(index);
    setAudioTrackLabel(list[index].label || `Дорожка ${index + 1}`);
    setShowControls(true);
  };

  /** Список дорожек для селектора: MKV-проба (языки/студии) → Chromium audioTracks. */
  const displayAudioTracks = useMemo(() => {
    if (mkvTracks.length > 1) {
      return mkvTracks.map((t, i) => ({ index: i, label: mkvTrackLabel(t) }));
    }
    return audioTracks;
  }, [mkvTracks, audioTracks]);

  /**
   * Парсинг встроенных аудиопотоков MKV из metadata TorrServer: Range-запрос
   * первых 2 МБ /stream + EBML-разбор Tracks (язык, студия озвучки, кодек).
   * Одна проба на сессию; ошибка — не критична (селектор просто не расширится).
   */
  useEffect(() => {
    if (!streamReady || isBuffering || mkvProbeDoneRef.current) return;
    if (!hash || !videoIndexRef.current) return;
    mkvProbeDoneRef.current = true;
    const probeUrl = streamUrl.includes('.m3u8')
      ? '' // gst-режим: файл пробируем отдельно (ниже)
      : streamUrl;
    (async () => {
      try {
        let url = probeUrl;
        if (!url) {
          url = await torrServerService.getStreamUrl(hash, videoIndexRef.current!, false).catch(() => '');
        }
        if (!url) return;
        const tracks = await probeAudioTracks(url);
        if (tracks.length > 1) {
          setMkvTracks(tracks);
          // gst по умолчанию транскодит первую дорожку (audio=0) — она активна
          setActiveAudioTrack(0);
          console.log(`[Player] MKV: найдено аудио-дорожек: ${tracks.length}`, tracks.map((t) => mkvTrackLabel(t)));
        }
      } catch {
        /* проба не удалась — оставляем Chromium-дорожки */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamReady, isBuffering, streamUrl, hash]);

  // TV: фокус на корне плеера — пульт сразу управляет воспроизведением
  useEffect(() => {
    if (tvMode) containerRef.current?.focus({ preventScroll: true });
  }, [tvMode]);

  // Клавиатурное управление
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape/Back теперь обрабатывает общий Back-стек (см. registerBackHandler)
      if (isBuffering || errorMsg || codecError) return;
      const target = e.target as HTMLElement;
      // Фокус на нативных контролах (кнопка/слайдер/seek-бар) — не перехватываем:
      // Space/Enter жмут кнопку, стрелки двигают фокус (spatial navigation WebView).
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON' || target.tagName === 'A')) return;
      if (target && target.closest('[data-seekbar]')) return;
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          if (tvMode) { focusControlsPanel('top'); break; }
          setVolumeLevel(Math.min(1, volume + 0.05));
          showVolumeHud(Math.round(Math.min(1, volume + 0.05) * 100));
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (tvMode) { focusControlsPanel('bottom'); break; }
          setVolumeLevel(Math.max(0, volume - 0.05));
          showVolumeHud(Math.round(Math.max(0, volume - 0.05) * 100));
          break;
        case 'ArrowLeft':
          e.preventDefault();
          skipSeconds(-10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          skipSeconds(10);
          break;
        case 'Enter':
          // OK на пульте = play/pause (как клик по видео)
          e.preventDefault();
          togglePlay();
          break;
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'f':
        case 'F':
        case 'а': // русская раскладка (F / А)
        case 'А':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          toggleMute();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBuffering, errorMsg, codecError, volume, isPlaying, duration, tvMode]);

  // Picture-in-Picture
  const togglePip = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPip(false);
      } else {
        await (video as any).requestPictureInPicture?.();
        setIsPip(true);
      }
    } catch (err: any) {
      console.warn('[Player] PiP error:', err?.message);
      toastBus.push('Picture-in-Picture недоступен', 'error');
    }
  };
  useEffect(() => {
    const onLeave = () => setIsPip(false);
    document.addEventListener('leavepictureinpicture', onLeave);
    return () => document.removeEventListener('leavepictureinpicture', onLeave);
  }, []);

  const resetFilters = () => {
    setFilters({ ...DEFAULT_FILTERS });
    setFiltersPage('root'); // после сброса возвращаемся к списку разделов (панель остаётся открытой)
  };

  // Pre-buffer target (80 MB) — clamp progress to 0–100, never divide by zero
  const PREBUFFER_BYTES = 80 * 1024 * 1024;

  // ── Детекция риска кодека: MKV / HEVC / AC3 (Chromium не умеет AC3/DTS и HEVC-в-MKV) ──
  const codecRisk = useMemo(() => {
    const v = (videoCodec || '').toUpperCase();
    const a = (audioCodec || '').toUpperCase();
    const ext = (containerExt || '').toLowerCase();
    // DTS / DTS-HD / TrueHD / E-AC3 / AC3 / Atmos / MLP — Chromium не декодирует
    const riskyAudio = /AC.?3|EAC.?3|EC.?3|DTS|TRUEHD|ATMOS|MLP/.test(a);
    const riskyVideo = v.includes('HEVC') || v.includes('H.265') || v.includes('X265') || v.includes('H265');
    const mkv = ext === 'mkv' || ext === 'mka';
    const risky = riskyAudio || (riskyVideo && mkv);
    return { risky, riskyAudio, audio: a || '—', video: v || '—', ext: ext || '—' };
  }, [videoCodec, audioCodec, containerExt]);

  /**
   * Нужен ли HLS-транскод TorrServer (gst → AAC): ДЛЯ ТОРРЕНТНЫХ РАЗДАЧ —
   * ВСЕГДА. Название раздачи не гарантирует детекцию кодека (часто Unknown),
   * а Chromium не декодирует AC3/EAC3/DTS/TrueHD/MLP — без транскода звук
   * пропадает на любых 4К-рипах (проверено live: «Через вселенные» играл по
   * /stream с оригинальным аудио без звука). gst ремуксует ТОЛЬКО аудио
   * (видео HEVC/H.264 остаётся исходным — без потерь), поэтому транскод
   * безопасен всегда. VK-direct (HLS/MP4) не проходит через TorrServer.
   */
  const needTranscode = !directUrl && transcodeAudioToAac;

  /** Защита от ping-pong native↔gst: одна попытка ретранскода на поток. */
  const gstTriedRef = useRef(false);

  // ── Сетевой перехватчик Referer для онлайн-потоков (CDN балансеров) ──
  // Hls.js ставит Referer через xhrSetup, но нативный <video>/mp4 заголовки
  // слать не умеет — регистрируем хост потока в main (webRequest.onBeforeSendHeaders),
  // чтобы Chromium слал Referer для манифеста и всех сегментов/mp4.
  useEffect(() => {
    if (!directUrl || !directReferer) return;
    let host = '';
    try { host = new URL(directUrl).hostname; } catch { /* некорректный URL */ }
    if (!host) return;
    window.electronAPI?.setOnlineStreamReferer?.(host, directReferer).catch(() => {});
    return () => {
      window.electronAPI?.clearOnlineStreamReferer?.(host).catch(() => {});
    };
  }, [directUrl, directReferer]);

  // Init torrent: предзагрузка + проверка HTTP 200 потока перед монтированием <video>
  useEffect(() => {
    gstTriedRef.current = false; // новая сессия — снова можно пробовать gst-ретраскод
    let statsInterval: NodeJS.Timeout | null = null;
    let probeInterval: NodeJS.Timeout | null = null;
    let cancelled = false;
    let stillBuffering = true;
    let probeOk = false;
    let probeAttempts = 0;
    let currentUrl = '';
    let torrentHash = '';
    let detectedExt = '';
    let videoIndex: number | undefined;
    const startTs = Date.now();   // начало буферизации
    let restartedOnce = false;    // рестарт на 5-й сек при 0 MB/s
    let restartedTwice = false;   // повторный рестарт на 15-й сек

    const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

    /**
     * Выбрать видео-файл из file_stats: предпочитаем видео-расширения,
     * иначе самый большой файл. Возвращает 1-based индекс для /stream.
     */
    const pickVideoIndex = (files: Array<{ id: number; path: string; length: number }>): number => {
      if (!files?.length) return 1;
      const videoRe = /\.(mp4|mkv|avi|webm|mov|m4v|ts|m2ts|wmv)$/i;
      let best = 0;
      for (let i = 1; i < files.length; i++) {
        const isVideo = videoRe.test(files[i].path || '');
        const isBestVideo = videoRe.test(files[best]?.path || '');
        if (isVideo && (!isBestVideo || files[i].length > files[best].length)) best = i;
        else if (!isVideo && !isBestVideo && files[i].length > files[best].length) best = i;
      }
      return best + 1; // TorrServer index — 1-based
    };

    /**
     * Проверка потока: /stream должен вернуть HTTP 200/206 (одновременно
     * «прогревает» TorrServer). Если сервер отдал текст (субтитр) — пересобираем
     * URL с правильным видео-индексом.
     */
    const ensureStream = async (url: string): Promise<boolean> => {
      const r = await torrServerService.probeStream(url);
      if (r.ok) {
        // index указывает на .srt/текст вместо видео → пробуем видео-файл
        if ((r.contentType || '').startsWith('text/') && videoIndex && torrentHash) {
          const vidUrl = await torrServerService.getStreamUrl(torrentHash, videoIndex, needTranscode);
          if (vidUrl && vidUrl !== url) {
            currentUrl = vidUrl;
            if (!cancelled) setStreamUrl(vidUrl);
            restartPreload(vidUrl);
            const r2 = await torrServerService.probeStream(vidUrl);
            return r2.ok && !(r2.contentType || '').startsWith('text/');
          }
        }
        return true;
      }
      // GST HLS не готов (файл ещё пишется на диск для gst-discoverer-1.0) →
      // прогреваем /stream (качает данные на диск) и повторяем /gst/ несколько
      // раз; только потом откат на обычный /stream (без транскода — на
      // AC3/DTS/TrueHD-раздачах звука не будет).
      if (url.includes('/gst/') && torrentHash) {
        try {
          const plainProbeUrl = await torrServerService.getStreamUrl(torrentHash, videoIndex, false);
          if (plainProbeUrl) await torrServerService.probeStream(plainProbeUrl, 8000);
        } catch {
          /* прогрев не критичен */
        }
        for (let attempt = 0; attempt < 4; attempt++) {
          await new Promise((r) => setTimeout(r, 3000));
          const r2 = await torrServerService.probeStream(url, 8000);
          if (r2.ok) return true;
        }
        const plainUrl = await torrServerService.getStreamUrl(torrentHash, videoIndex, false);
        if (plainUrl && plainUrl !== url) {
          currentUrl = plainUrl;
          if (!cancelled) setStreamUrl(plainUrl);
          restartPreload(plainUrl);
          return await torrServerService.probeStream(plainUrl).then((r2) => r2.ok);
        }
      }
      return false;
    };

    const init = async () => {
      try {
        // ── Прямой поток (VK Video HLS/MP4): без TorrServer и GStreamer.
        //    URL сразу уходит в адаптивный эффект (Hls.js для .m3u8 /
        //    нативный src для mp4), буферизационный экран пропускается. ──
        if (directUrl) {
          // vkstream:// — прокси VK (main); https — обычный прямой поток
          if (!/^(https?:\/\/|vkstream:\/\/)/i.test(directUrl)) {
            throw new Error('Некорректная прямая ссылка потока (VK Video)');
          }
          currentUrl = directUrl;
          if (!cancelled) {
            setStreamUrl(directUrl);
            setStreamReady(true);
            setSkipRequested(true);
            setIsBuffering(false);
            setOnlineLoading(true); // «Подключение к источнику…» до первого playing
          }
          return;
        }

        // ── Блокировка отправки хэшей: ждём готовности TorrServer (/echo 200) ──
        const st = await torrServerService.getStatus();
        if (!st.running) {
          if (st.starting) {
            // Сервис в процессе запуска — пинг-петля /echo до 30 сек
            let ready = false;
            for (let i = 0; i < 30; i++) {
              const s2 = await torrServerService.getStatus();
              if (s2.running) { ready = true; break; }
              await new Promise((r) => setTimeout(r, 1000));
            }
            if (!ready) {
              throw new Error('TorrServer не запустился (сервис в процессе запуска). Проверьте логи TorrServer в настройках.');
            }
          } else {
            throw new Error('TorrServer не запущен. Запустите его в настройках (кнопка «Запустить TorrServer»).');
          }
        }

        // ── Ретрай добавления: /echo отвечает сразу, но внутренний BT-клиент
        //    TorrServer инициализируется ~20-30 сек после старта. В это время
        //    add возвращает 500 «BT client not connected» — повторяем с паузой.
        const addWithRetry = async (attempts: number, retryDelayMs: number): Promise<any> => {
          for (let attempt = 0; attempt < attempts; attempt++) {
            // rutracker: .torrent-файл надёжнее магнета (метаданные локально)
            const res = torrentFile
              ? await torrServerService.addTorrentFile(torrentFile, title)
              : await torrServerService.addMagnet(magnet, title, poster);
            if (res.success || res.data) return res;
            const errText = String(res.error || '');
            const isBtNotReady = /BT client not connected|500|TorrServer API returned/i.test(errText);
            if (!isBtNotReady) return res; // другие ошибки — не ретраим
            if (!cancelled && attempt < attempts - 1) {
              console.warn(`[Player] TorrServer BT client not ready (attempt ${attempt + 1}) — retrying in ${retryDelayMs / 1000}s`);
              await new Promise((r) => setTimeout(r, retryDelayMs));
            }
          }
          return { success: false, error: 'TorrServer: BT-клиент не готов', btNotReady: true };
        };

        let addRes = await addWithRetry(6, 3000);
        if (!addRes.success && !addRes.data && addRes.btNotReady) {
          // Последний рубеж: BT-клиент завис — полный перезапуск TorrServer
          // (main-процесс сбрасывает settings.json → чистый старт) и повтор.
          console.warn('[Player] BT client stuck — restarting TorrServer (self-heal)');
          await torrServerService.restartServer().catch(() => {});
          if (!cancelled) await new Promise((r) => setTimeout(r, 25000)); // старт + инициализация клиента
          addRes = await addWithRetry(6, 3000);
        }
        if (!addRes.success && !addRes.data) throw new Error(addRes.error || 'Ошибка добавления торрента');

        torrentHash = addRes.data?.hash || 'demo-hash-12345';
        setHash(torrentHash);

        // Ждём метаданные торрента (file_stats пуст сразу после add) — до 10 сек.
        // Нужно, чтобы выбрать ВИДЕО-файл, а не субтитр (.srt первым в раздаче).
        for (let i = 0; i < 10 && !cancelled; i++) {
          try {
            const early = await torrServerService.getTorrentStats(torrentHash);
            const earlyStats = early.data?.file_stats;
            const files = early.success && Array.isArray(earlyStats) ? earlyStats : [];
            if (files.length > 0) {
              videoIndex = pickVideoIndex(files);
              videoIndexRef.current = videoIndex;
              const m = (files[0].path || '').match(/\.([a-z0-9]{2,4})$/i);
              if (m) { detectedExt = m[1].toLowerCase(); setContainerExt(detectedExt); }
              break;
            }
          } catch {
            /* retry */
          }
          await new Promise((r) => setTimeout(r, 1000));
        }

        currentUrl = await torrServerService.getStreamUrl(torrentHash, videoIndex, needTranscode);
        if (!cancelled) setStreamUrl(currentUrl);

        // ── Предзагрузка ВСЕГДА по обычному /stream (Range 0-250MB) ──
        // Прелоад m3u8-плейлиста (/gst/master.m3u8) НЕ востребует данные торрента —
        // TorrServer качает только запрошенные сегменты → экран буферизации висит
        // на 0.0 MB/s. Плейлист (gst) уходит только в <video> через hls.js.
        const preloadUrl =
          (await torrServerService.getStreamUrl(torrentHash, videoIndex, false).catch(() => null)) || currentUrl;

        // ── Сразу открываем непрерывный поток: TorrServer начинает качать
        //    незамедлительно, экран буферизации показывает реальную скорость ──
        startPreload(preloadUrl);

        // ── 1) Статистика торрента: кольцо буфера, скорость, пиры, контейнер ──
        statsInterval = setInterval(async () => {
          if (cancelled) return;
          try {
            const statRes = await torrServerService.getTorrentStats(torrentHash);
            if (statRes.success && statRes.data) {
              const st = statRes.data;
              setStats(st);
              // Определяем контейнер по расширению первого файла (mkv/mp4/ts)
              if (!detectedExt && st.file_stats?.length) {
                const m = (st.file_stats[0].path || '').match(/\.([a-z0-9]{2,4})$/i);
                if (m) { detectedExt = m[1].toLowerCase(); setContainerExt(detectedExt); }
                // Метаданные пришли поздно — выбираем видео-файл и пересобираем URL
                if (!videoIndex && st.file_stats.length > 0) {
                  const idx = pickVideoIndex(st.file_stats);
                  videoIndexRef.current = idx;
                  if (idx !== 1 && torrentHash) {
                    videoIndex = idx;
                    torrServerService.getStreamUrl(torrentHash, idx, needTranscode).then((u) => {
                      if (u && !cancelled && u !== currentUrl) {
                        currentUrl = u;
                        setStreamUrl(u);
                        restartPreload(preloadUrl);
                      }
                    });
                  } else {
                    videoIndex = idx;
                  }
                }
              }
              const loaded = Number.isFinite(st.loaded_size) ? Math.max(0, st.loaded_size) : 0;
              const pct = clampPct((loaded / Math.max(1, PREBUFFER_BYTES)) * 100);
              setBufPercent(pct);
              // ── macOS P2P-фикс: скорость 0.0 MB/s → рестарт торрента (rem+add) ──
              // Через 5 сек после начала буферизации при 0 MB/s — сброс пиров.
              // Если не помогло, повторный рестарт на 15-й секунде.
              const elapsedSec = (Date.now() - startTs) / 1000;
              const speedZero = !Number.isFinite(st.download_speed) || st.download_speed === 0;
              if (speedZero && elapsedSec >= 5 && !restartedOnce) {
                restartedOnce = true;
                console.warn(`[Player] DownloadSpeed=0 for 5s — forcing torrent restart (rem+add) to re-announce DHT/trackers`);
                torrServerService.reconnect(torrentHash, magnet).catch(() => {});
                // После пересоздания торрента переоткрываем предзагрузочный поток
                setTimeout(() => restartPreload(preloadUrl), 4000);
              } else if (speedZero && elapsedSec >= 15 && !restartedTwice) {
                restartedTwice = true;
                console.warn('[Player] Still 0 MB/s — second torrent restart (rem+add)');
                torrServerService.reconnect(torrentHash, magnet).catch(() => {});
                setTimeout(() => restartPreload(preloadUrl), 4000);
              }
              // Выходим из буферизации только при подтверждённом потоке
              // + (достаточно данных ИЛИ пользователь нажал «Пропустить»)
              if (stillBuffering && probeOk && (skipRequested || st.stat === 2 || loaded > 12 * 1024 * 1024 || pct >= 100)) {
                stillBuffering = false;
                setIsBuffering(false);
              }
            }
          } catch {
            /* poll errors are non-fatal during buffer */
          }
        }, 1000);

        // ── 2) Предзагрузка + проверка HTTP 200 (интервал 1.5s, до MAX_PROBE_ATTEMPTS) ──
        probeInterval = setInterval(async () => {
          if (cancelled || probeOk) return;
          probeAttempts++;
          const ok = await ensureStream(currentUrl);
          if (cancelled) return;
          if (ok) {
            probeOk = true;
            setStreamReady(true);
          } else if (probeAttempts >= MAX_PROBE_ATTEMPTS) {
            // Поток так и не ответил — стоп
            stillBuffering = false;
            setIsBuffering(false);
            setErrorMsg('TorrServer не ответил на поток. Проверьте, что TorrServer запущен (статус Online), и попробуйте снова.');
          }
        }, 1500);

        // Первая проверка — сразу
        probeAttempts++;
        const first = await ensureStream(currentUrl);
        if (cancelled) return;
        if (first) { probeOk = true; setStreamReady(true); }
      } catch (err: any) {
        if (!cancelled) {
          const raw = String(err?.message || err || '');
          // 500 от TorrServer / невалидная ссылка → понятная деталь для пользователя
          setErrorMsg(
            /500|TorrServer API returned|Некорректная торрент-ссылка/i.test(raw)
              ? 'Ошибка добавления торрента: неверный формат раздачи или битый magnet-link'
              : raw
          );
          setIsBuffering(false);
        }
      }
    };

    init();
    return () => {
      cancelled = true;
      stopPreload();
      if (statsInterval) clearInterval(statsInterval);
      if (probeInterval) clearInterval(probeInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [magnet, title, poster, transcodeAudioToAac, directUrl, torrentFile]);

  /** «Пропустить буферизацию»: НЕ монтируем пустой <video> мгновенно —
   *  продолжаем ждать валидный HTTP 200 от потока, но без ожидания порога предзагрузки. */
  const handleSkipBuffering = () => {
    setSkipRequested(true);
    if (streamReady) setIsBuffering(false);
  };

  /**
   * Непрерывная предзагрузка: fetch /stream с Range и чтение тела в фоне.
   * TorrServer MatriX НЕ качает данные, пока файл не востребован потоком —
   * прерывистые probe-запросы (Range 0-2MB) дают застревание на 0.0 MB/s.
   * Открытое соединение, читающее тело, заставляет сервер активно тянуть
   * куски из пиров. Данные дропаются — они остаются в RAM-кэше TorrServer.
   */
  const startPreload = (url: string) => {
    if (!url || preloadRef.current.controller) return; // уже активен
    const controller = new AbortController();
    preloadRef.current.controller = controller;
    (async () => {
      try {
        const res = await fetch(url, {
          headers: { Range: 'bytes=0-262144000' }, // предзагрузка до 250 MB
          signal: controller.signal,
        });
        if (!res.body) return;
        const reader = res.body.getReader();
        while (!controller.signal.aborted) {
          const { done } = await reader.read();
          if (done) break;
        }
        try { reader.releaseLock(); } catch { /* ignore */ }
      } catch {
        /* aborted / сетевая ошибка — не критично */
      }
    })();
  };

  const stopPreload = () => {
    try { preloadRef.current.controller?.abort(); } catch { /* ignore */ }
    preloadRef.current.controller = null;
  };

  const restartPreload = (url: string) => {
    stopPreload();
    if (url) startPreload(url);
  };

  /** Когда буферизация завершена/ошибка — останавливаем фоновую предзагрузку
   *  (видео-элемент продолжает качать поток сам). */
  useEffect(() => {
    if (!isBuffering || errorMsg) stopPreload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBuffering, errorMsg]);

  /**
   * Авто-фоновый ретранскод AC3/DTS/E-AC3 → AAC через GST HLS TorrServer.
   * Вызывается при onError или 5-сек простое: если аудио-кодек рискованный и
   * поток ещё не в транскоде — пересобираем URL и перезапускаем поток БЕЗ
   * оверлея (видео не замораживается, даём ещё один START_TIMEOUT).
   * Возвращает true, если фоновый ретранскод запущен.
   */
  const tryAutoRetranscode = async (force: boolean = false): Promise<boolean> => {
    // Плановый режим: если транскод уже выбран по метаданным (needTranscode) —
    // переключать нечего. При force (реальная ошибка декодирования) пробуем gst
    // даже при включённой настройке — метаданные могли не совпасть с фактическим
    // потоком (раздача заявлена как AAC, а внутри DTS/TrueHD).
    if (!force && (transcodeAudioToAac || !codecRisk.risky)) return false;
    if (!hash || !videoIndexRef.current) return false;           // нет индекса файла
    if (streamUrl && streamUrl.includes('/gst/')) return false;  // уже в транскоде
    if (gstTriedRef.current) return false;                       // защита от ping-pong native↔gst
    gstTriedRef.current = true;
    const gstUrl = await torrServerService.getStreamUrl(hash, videoIndexRef.current, true).catch(() => null);
    if (!gstUrl || gstUrl === streamUrl) return false;
    console.warn('[Player] AC3/DTS/HEVC — фоновая перекодировка в AAC (GST HLS), повторная попытка…');
    setStreamUrl(gstUrl);
    restartPreload(gstUrl);
    return true;
  };

  /** onError на <video>: кодек/контейнер не поддерживается Chromium. */
  const handleVideoError = async () => {
    const err = videoRef.current?.error;
    const code = err?.code ?? -1;
    // MEDIA_ERR_DECODE (3) / MEDIA_ERR_SRC_NOT_SUPPORTED (4) — кодек/контейнер:
    // сначала автоматически переключаемся на транскодированный поток (gst → AAC),
    // оверлей VLC/IINA показываем ТОЛЬКО если ретранскод не помог (никакого
    // чёрного экрана — всегда либо новый источник, либо понятное уведомление).
    if (code === 3) setMediaErrorDetail('MEDIA_ERR_DECODE — кодек/контейнер не поддерживается');
    else if (code === 4) setMediaErrorDetail('MEDIA_ERR_SRC_NOT_SUPPORTED — поток не поддерживается');
    else setMediaErrorDetail(`Код ошибки ${code}`);
    console.error('[Player] Video element error:', err || 'unknown', `code=${code}`);
    if (await tryAutoRetranscode(true)) return;
    setCodecError(true);
  };

  /** Уничтожить инстанс Hls.js (при смене URL / закрытии / fallback на нативный src). */
  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      try { hlsRef.current.destroy(); } catch { /* ignore */ }
      hlsRef.current = null;
    }
    setIsHlsMode(false);
  }, []);

  /**
   * Адаптивный рендер потока:
   * 1. HLS-URL (/gst/master.m3u8, hls=true) + Hls.isSupported() → Hls.js (MSE).
   *    Видео HEVC/H.265, аудио AC3/DTS/TrueHD транскодируются TorrServer MatriX.gst.
   * 2. Обычный /stream → нативный src (H.264/AAC/MP4 без накладных расходов).
   * Оверлей VLC/IINA показывается ТОЛЬКО после фатальной ошибки Hls.js/gst.
   */
  useEffect(() => {
    const video = videoRef.current;
    // <video> монтируется только после выхода из буферизации (STATE «видео»).
    // deps включают isBuffering: при монтировании video эффект перезапускается
    // и применяет поток (src / Hls.js) — иначе видео оставалось бы без источника.
    if (!video || !streamReady) return;
    destroyHls();

    // Рискованное аудио (AC3/DTS/TrueHD/EAC3): нативный путь даст видео БЕЗ звука —
    // переключаемся на HLS-транскод (gst → AAC), но ТОЛЬКО когда данные уже начали
    // качаться (streamReady = HTTP 200 /stream) — иначе gst-discoverer не сможет
    // проанализировать ещё не скачанный файл («no stream info»).
    if (
      codecRisk.riskyAudio &&
      transcodeAudioToAac &&
      !streamUrl.includes('/gst/') &&
      hash &&
      videoIndexRef.current
    ) {
      torrServerService
        .getStreamUrl(hash, videoIndexRef.current, true)
        .then((gstUrl) => {
          if (gstUrl && gstUrl !== streamUrl && videoRef.current && hlsRef.current === null) {
            console.warn('[Player] AC3/DTS — переключение на HLS-транскод (AAC) после начала загрузки');
            setStreamUrl(gstUrl);
          }
        })
        .catch(() => {});
      return;
    }

    const isHlsUrl =
      streamUrl.includes('.m3u8') || streamUrl.includes('/gst/') || streamUrl.includes('hls=true');
    if (isHlsUrl && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        // CDN балансеров (kinobox/alloha/videocdn) и VK отдают 403 без правильного
        // Referer — добавляем его для прямых потоков (VK Video / онлайн-балансеры).
        // gst-манифесты TorrServer (свой сервер) не трогаем.
        xhrSetup: (xhr) => {
          if (/vk\.com|vkvd|vkuservideo/i.test(streamUrl)) {
            xhr.setRequestHeader('Referer', 'https://vk.com/');
          } else if (directReferer) {
            xhr.setRequestHeader('Referer', directReferer);
          }
        },
      });
      let netRetries = 0;
      hlsRef.current = hls;
      setIsHlsMode(true);
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const tracks = (hls.audioTracks || []).map((t, i) => ({
          index: i,
          label: t.name || (t as any).langCode || `Дорожка ${i + 1}`,
        }));
        if (tracks.length) setAudioTracks(tracks);
        // автовыбор первой дорожки (gst отдаёт AAC stereo первым по умолчанию)
        if (hls.audioTracks.length) {
          hls.audioTrack = 0;
          setActiveAudioTrack(0);
        }
        // Качество (только онлайн): уровни из манифеста → кнопка в контрол-баре.
        // gst-манифесты TorrServer не трогаем — там видео остаётся исходным.
        if (isOnline) {
          const levels = (hls.levels || []).map((l, i) => ({
            index: i,
            label: l.height ? `${l.height}p` : l.bitrate ? `${Math.round(l.bitrate / 1000)}kbps` : `Уровень ${i + 1}`,
          }));
          if (levels.length > 1) {
            setHlsLevels(levels);
            // применяем сохранённый выбор качества (по метке), иначе Авто
            const saved = loadSavedQuality();
            if (saved !== 'auto') {
              const savedIdx = levels.findIndex((lv) => lv.label === saved);
              if (savedIdx >= 0) {
                hls.currentLevel = savedIdx;
                setQualityAuto(false);
              }
            }
          }
        }
      });
      // Текущий уровень (для кнопки качества): срабатывает при ручном выборе и авто
      hls.on(Hls.Events.LEVEL_SWITCHED, (_evt, data) => {
        setCurrentLevel(data.level ?? -1);
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        console.warn('[Player] Hls fatal error:', data.type, data.details);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          // Сетевая ошибка (gst недоступен/404 на обычном бинарнике) — до 3 авто-retry,
          // затем авто-откат на нативный /stream, и только потом оверлей VLC.
          if (netRetries < 3) {
            netRetries++;
            setTimeout(() => hls.startLoad(), 1200);
            return;
          }
          if (fallbackToNativeStream()) return;
          setCodecError(true);
          return;
        }
        // MEDIA_ERROR и прочие фатальные: MSE не декодирует даже транскод →
        // пробуем нативный поток, затем оверлей «Открыть через VLC / IINA».
        if (fallbackToNativeStream()) return;
        setCodecError(true);
      });
    } else if (streamUrl) {
      // Нативный путь: H.264/AAC/MP4 (или Hls недоступен — крайний случай)
      video.src = streamUrl;
    }
    return () => { destroyHls(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl, streamReady, isBuffering]);

  /** Открыть поток во внешнем плеере (VLC → IINA → браузер). */
  const openExternalPlayer = async () => {
    let url = streamUrl;
    // Для внешнего плеера отдаём НАИВНЫЙ /stream от TorrServer — VLC/IINA
    // декодируют MKV/HEVC/DTS/TrueHD нативно, транскод gst не нужен.
    if (url.includes('/gst/') && hash && videoIndexRef.current) {
      const plain = await torrServerService.getStreamUrl(hash, videoIndexRef.current, false).catch(() => null);
      if (plain) url = plain;
    }
    if (!url) return;
    if (window.electronAPI?.openInExternalPlayer) {
      const res = await window.electronAPI.openInExternalPlayer(url);
      if (!res.success) {
        toastBus.push('Не удалось открыть внешний плеер', 'error');
      }
      return;
    }
    window.open(url, '_blank');
  };

  /** Авто-откат с транскодированного HLS (gst) на нативный /stream:
   *  срабатывает, когда gst-манифест недоступен/падает, а сам файл Chromium
   *  может декодировать — поток не теряется, оверлей не выскакивает. */
  const fallbackToNativeStream = useCallback(() => {
    if (!hash || !videoIndexRef.current) return false;
    if (!streamUrl || !streamUrl.includes('/gst/')) return false;
    torrServerService
      .getStreamUrl(hash, videoIndexRef.current, false)
      .then((plainUrl) => {
        if (plainUrl && plainUrl !== streamUrl && hlsRef.current) {
          console.warn('[Player] gst HLS недоступен — авто-откат на нативный /stream');
          setStreamUrl(plainUrl);
        }
      })
      .catch(() => {});
    return true;
  }, [hash, streamUrl]);

  /** Если видео не начало воспроизводиться за 5 секунд — оверлей «Откройте через VLC».
   *  Ложные срабатывания исключены: оверлей показывается ТОЛЬКО если видео
   *  реально не играет (readyState < 2 И currentTime === 0), и автоматически
   *  скрывается при первом же `playing` / `timeupdate`. */
  useEffect(() => {
    if (isBuffering || errorMsg || codecError || !streamUrl) return;
    const video = videoRef.current;
    if (!video) return;

    let timer: NodeJS.Timeout | null = null;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const onPlaying = () => {
      clearTimer();
      // Видео пошло (возможно, медленно после буферизации) — снять ошибочный оверлей
      if (codecError) setCodecError(false);
    };

    video.addEventListener('playing', onPlaying);
    timer = setTimeout(async () => {
      // Поток не воспроизводится: данные не подгрузились И таймкод не пошёл.
      // Если readyState >= 3 или currentTime > 0 — видео УЖЕ играет, оверлей не нужен.
      if (!video.error && video.readyState < 2 && video.currentTime === 0) {
        // AC3/DTS: сначала фоновая перекодировка в AAC — оверлей только если не помогло
        if (await tryAutoRetranscode(true)) { clearTimer(); return; }
        console.warn('[Player] Stream did not start within 5s — showing codec fallback');
        setCodecError(true);
      }
      clearTimer();
    }, START_TIMEOUT_MS);

    return () => {
      clearTimer();
      video.removeEventListener('playing', onPlaying);
    };
  }, [isBuffering, errorMsg, codecError, streamUrl]);

  const handleClose = () => {
    // Сохранить прогресс в историю (если видео играло)
    if (onProgressSave && videoRef.current && !isBuffering) {
      onProgressSave(videoRef.current.currentTime || 0, videoRef.current.duration || 0);
    }
    destroyHls();
    if (hash) torrServerService.dropCache(hash);
    onClose();
  };

  // ── Back (пульт/Escape/Backspace): закрывает плеер (см. handleClose).
  // В TV-режиме Back из панели контролов сначала возвращает фокус на видео.
  useEffect(() => registerBackHandler(() => {
    const root = containerRef.current;
    const active = document.activeElement as HTMLElement | null;
    if (tvMode && root && active && active !== root && root.contains(active)) {
      root.focus();
      return true;
    }
    handleClose();
    return true;
  }), [tvMode, handleClose]);

  /** Видео завершилось — end-screen (авто-следующее для сериалов в UI каталога). */
  const handleEnded = () => {
    if (onProgressSave && videoRef.current) {
      onProgressSave(videoRef.current.duration || 0, videoRef.current.duration || 0);
    }
    setIsEnded(true);
    setShowControls(true);
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
    setDuration(video.duration || 0);
    if (video.buffered.length > 0) {
      setBuffered(video.buffered.end(video.buffered.length - 1));
    }
    // Видео реально играет (таймкод пошёл) → снять ложный оверлей ошибки кодека
    if (codecError && video.currentTime > 0) {
      setCodecError(false);
    }
  };

  /** On video metadata loaded, auto-select AAC/MP3 audio track for Chromium compatibility */
  const handleVideoMetadata = () => {
    if (!videoRef.current) return;
    const chosen = selectCompatibleAudioTrack(videoRef.current);
    if (chosen) {
      setAudioTrackLabel(chosen);
      console.log('[Player] Auto-selected compatible audio track:', chosen);
    }
    collectAudioTracks();
    // Возобновление просмотра: сначала явный seek после переключения аудиодорожки
    // (позиция не сбрасывается), затем стартовый таймкод из истории.
    const video = videoRef.current;
    let resumeTo: number | null = null;
    if (seekOnLoadRef.current != null && seekOnLoadRef.current > 0) {
      resumeTo = seekOnLoadRef.current;
      seekOnLoadRef.current = null;
    } else if (startPosition && startPosition > 5 && video.duration && startPosition < video.duration - 10) {
      resumeTo = startPosition;
    }
    if (resumeTo != null && video.duration && resumeTo < video.duration - 1) {
      video.currentTime = resumeTo;
      console.log(`[Player] Resume to ${Math.round(resumeTo)}s`);
    }
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) { videoRef.current.pause(); setIsPlaying(false); }
    else { videoRef.current.play(); setIsPlaying(true); }
  };

  // ── Клик по видео: одиночный — Play/Pause, двойной — Fullscreen.
  //    Одиночный клик откладывается на 260 мс и отменяется при dblclick,
  //    чтобы двойной клик не «мигал» паузой перед переключением fullscreen.
  //    Обработчик вешается и на <video>, и на оверлей управления (он перехватывает
  //    клики по полотну, когда панель видна) — поэтому клик по области изображения
  //    всегда переключает play/pause.
  const singleClickTimer = useRef<number | null>(null);
  const handleVideoClick = (e: React.MouseEvent) => {
    // Клики по элементам управления (кнопки, ползунки input) и нижней панели
    // управления (data-player-controls, включая прогресс-бар и панель фильтров)
    // не должны переключать play/pause — только клики по самому полотну видео.
    const target = e.target as HTMLElement;
    if (target.closest('button, input') || target.closest('[data-player-controls]')) return;
    if (singleClickTimer.current) window.clearTimeout(singleClickTimer.current);
    singleClickTimer.current = window.setTimeout(() => {
      singleClickTimer.current = null;
      togglePlay();
    }, 260);
  };
  const handleVideoDoubleClick = () => {
    if (singleClickTimer.current) {
      window.clearTimeout(singleClickTimer.current);
      singleClickTimer.current = null;
    }
    toggleFullscreen();
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || !videoRef.current || !duration) return;
    const rect = progressRef.current.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const time = ratio * duration;
    videoRef.current.currentTime = Math.max(0, Math.min(duration, time));
    setCurrentTime(time);
    setScrubPreviewImg(null); // после перехода превью больше неактуально
  };

  /** Scrubber: тултип с временем при наведении на прогресс-бар. */
  const handleScrubHover = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || !duration) return;
    const rect = progressRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = ratio * duration;
    setScrubHover({ x: Math.max(0, e.clientX - rect.left), time });
    // Превью кадра: отложенный захват (нативные потоки), чтобы не спамить seek
    if (scrubPreviewTimer.current) clearTimeout(scrubPreviewTimer.current);
    if (nativeStream) {
      scrubPreviewTimer.current = setTimeout(() => capturePreviewFrame(time), 200);
    }
  };

  /** Захват кадра для превью: скрытый <video> ищет позицию → кадр в canvas → тултип. */
  const capturePreviewFrame = (time: number) => {
    const cv = captureVideoRef.current;
    const canvas = captureCanvasRef.current;
    if (!cv || !canvas || cv.readyState < 1) { setScrubPreviewImg(null); return; }
    const seq = ++captureSeqRef.current;
    const onSeeked = () => {
      if (seq !== captureSeqRef.current) return; // устаревший seek — кадр уже не нужен
      const ctx = canvas.getContext('2d');
      if (!ctx || !cv.videoWidth || !cv.videoHeight) { setScrubPreviewImg(null); return; }
      canvas.width = cv.videoWidth;
      canvas.height = cv.videoHeight;
      ctx.drawImage(cv, 0, 0, canvas.width, canvas.height);
      setScrubPreviewImg(canvas.toDataURL('image/jpeg', 0.72));
    };
    cv.addEventListener('seeked', onSeeked, { once: true });
    try { cv.currentTime = Math.max(0, Math.min(time, cv.duration || time)); } catch { /* ignore */ }
    // Если seek не завершился за 1.5с — фолбэк на тултип со временем
    window.setTimeout(() => cv.removeEventListener('seeked', onSeeked), 1500);
  };

  /** Выбор качества (онлайн): hls.currentLevel = index | -1 (авто). */
  const selectQuality = (index: number) => {
    const hls = hlsRef.current;
    if (!hls) return;
    setShowQuality(false);
    if (index === -1) {
      hls.currentLevel = -1; // авто-выбор
      setQualityAuto(true);
      saveSavedQuality('auto');
      return;
    }
    hls.currentLevel = index;
    setQualityAuto(false);
    setCurrentLevel(index);
    const lv = hlsLevels.find((l) => l.index === index);
    if (lv) saveSavedQuality(lv.label);
  };

  /** Общий стиль пунктов выпадающего меню качества. */
  const qualityItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.35rem',
    width: '100%',
    padding: '0.4rem 0.6rem',
    borderRadius: '8px',
    background: 'transparent',
    fontSize: '0.72rem',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'all 0.15s ease',
  };

  /** Заголовок текущей страницы панели параметров. */
  const filtersPageTitle =
    filtersPage === 'root' ? 'Параметры'
    : filtersPage === 'image' ? 'Изображение'
    : filtersPage === 'scale' ? 'Масштаб'
    : filtersPage === 'speed' ? 'Скорость'
    : filtersPage === 'audio' ? 'Аудиодорожка'
    : 'Субтитры';

  /** Ряд раздела в корне панели параметров → переход на отдельную страницу. */
  const settingsRow = (icon: React.ReactNode, label: string, page: 'image' | 'scale' | 'speed' | 'audio' | 'subs') => (
    <button
      onClick={() => setFiltersPage(page)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.55rem',
        width: '100%',
        padding: '0.55rem 0.6rem',
        borderRadius: '10px',
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.07)',
        color: 'var(--text-secondary)',
        fontSize: '0.76rem',
        fontWeight: 700,
        fontFamily: 'inherit',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'all 0.15s ease',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = 'rgba(0,242,254,0.08)';
        e.currentTarget.style.borderColor = 'rgba(0,242,254,0.3)';
        e.currentTarget.style.color = 'var(--cyan)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)';
        e.currentTarget.style.color = 'var(--text-secondary)';
      }}
    >
      <span style={{ color: 'var(--text-muted)', display: 'flex' }}>{icon}</span>
      {label}
      <span style={{ marginLeft: 'auto', color: 'rgba(240,242,248,0.3)', display: 'flex' }}>
        <ChevronRight size={14} />
      </span>
    </button>
  );

  const handleControlsPoke = () => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
        setShowQuality(false); // меню качества скрывается вместе с контролами
      }
    }, 3500);
  };

  /** TV: ArrowUp/Down с видео → фокус в верхнюю/нижнюю панель контролов. */
  const focusControlsPanel = (which: 'top' | 'bottom') => {
    handleControlsPoke();
    requestAnimationFrame(() => {
      const root = containerRef.current;
      if (!root) return;
      const panel = which === 'top'
        ? root.querySelector<HTMLElement>('[data-player-topbar]')
        : root.querySelector<HTMLElement>('[data-player-controls]');
      const el = panel?.querySelector<HTMLElement>('button, [tabindex]:not([tabindex="-1"])');
      el?.focus();
    });
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    const newMuted = !isMuted;
    videoRef.current.muted = newMuted;
    setIsMuted(newMuted);
  };

  const setVolumeLevel = (val: number) => {
    setVolume(val);
    if (videoRef.current) { videoRef.current.volume = val; setIsMuted(val === 0); }
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const skipSeconds = (sec: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = Math.max(0, Math.min(duration, videoRef.current.currentTime + sec));
  };

  const formatTime = (sec: number) => {
    if (isNaN(sec) || !isFinite(sec)) return '00:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;
  const speedMb = stats?.download_speed ? (stats.download_speed / (1024 * 1024)).toFixed(1) : '0.0';

  /** Нативный поток (не HLS) — только для него доступно превью кадров. */
  const nativeStream =
    !!streamUrl &&
    !isOnline &&
    !streamUrl.includes('.m3u8') &&
    !streamUrl.includes('/gst/') &&
    !streamUrl.includes('hls=true');

  /** Текущее качество (онлайн): фактический уровень → ярлык из источника. */
  const currentQualityLabel = useMemo(() => {
    const lv = hlsLevels.find((l) => l.index === currentLevel)?.label;
    return lv || directQuality || 'Авто';
  }, [hlsLevels, currentLevel, directQuality]);

  // Скрытый видео-элемент для превью кадров: подключаем к нативному /stream
  useEffect(() => {
    const cv = captureVideoRef.current;
    if (!cv) return;
    if (!nativeStream) {
      cv.removeAttribute('src');
      try { cv.load(); } catch { /* ignore */ }
      return;
    }
    cv.src = streamUrl;
    cv.preload = 'metadata';
    try { cv.load(); } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl, streamReady]);

  // Закрытие меню качества по клику вне него
  useEffect(() => {
    if (!showQuality) return;
    const onDoc = (e: MouseEvent) => {
      if (qualityRef.current && !qualityRef.current.contains(e.target as Node)) setShowQuality(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [showQuality]);

  // Закрытие панели параметров по клику вне неё (клик по кнопке-триггеру игнорируем)
  useEffect(() => {
    if (!showFilters) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-filters-toggle]')) return;
      if (filtersPanelRef.current && !filtersPanelRef.current.contains(target)) setShowFilters(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [showFilters]);

  // Очистка при размонтировании: таймер превью + скрытый видео-элемент
  useEffect(() => {
    return () => {
      if (scrubPreviewTimer.current) clearTimeout(scrubPreviewTimer.current);
      captureVideoRef.current?.removeAttribute('src');
    };
  }, []);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      data-player-root
      onMouseMove={handleControlsPoke}
      onPointerDown={handleControlsPoke}
      onKeyDown={handleControlsPoke}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {/* ── Top Bar: название фильма + закрыть (как у Netflix, скрывается вместе с контролами) ── */}
      <div
        data-player-topbar
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 50,
          padding: '1.25rem 1.25rem 3rem',
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.55) 55%, transparent 100%)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem',
          opacity: showControls || isBuffering ? 1 : 0,
          transition: 'opacity 0.35s ease',
          pointerEvents: showControls || isBuffering ? 'auto' : 'none',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 0 }}>
          <span style={{ fontSize: '1.05rem', fontWeight: 800, color: 'rgba(255,255,255,0.95)', textShadow: '0 2px 12px rgba(0,0,0,0.7)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </span>
          <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'rgba(0,242,254,0.7)', letterSpacing: '0.04em' }}>
            {isOnline ? 'Онлайн-поток' : 'Торрент · TorrServer'}
            {isOnline && currentQualityLabel && ` · ${currentQualityLabel}`}
          </span>
        </div>
        <button
          onClick={handleClose}
          style={{
            flexShrink: 0,
            width: '42px',
            height: '42px',
            borderRadius: '50%',
            background: 'rgba(10,11,14,0.9)',
            border: '1px solid rgba(255,255,255,0.12)',
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
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.12)';
          }}
        >
          <X size={18} />
        </button>
      </div>

      {/* ════════════════════════════════════════
          STATE 1: FUTURISTIC BUFFERING SCREEN (ТОЛЬКО ТОРРЕНТ)
          Онлайн-потоки пропускают этот экран — у них свой лёгкий лоадер. ═══ */}
      {isBuffering && !isOnline ? (
        <div
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            width: '100%',
            maxWidth: '520px',
            padding: '2.5rem 2rem',
          }}
        >
          {/* Ambient Glow BG */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'radial-gradient(circle at 50% 40%, rgba(0,242,254,0.06) 0%, transparent 70%)',
              pointerEvents: 'none',
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'radial-gradient(circle at 50% 80%, rgba(138,43,226,0.06) 0%, transparent 70%)',
              pointerEvents: 'none',
            }}
          />

          {/* Neon Ring Spinner */}
          <NeonRingSpinner percent={bufferPercent} />

          {/* Title */}
          <div style={{ marginTop: '1.6rem', textAlign: 'center' }}>
            <div
              style={{
                fontSize: '0.68rem',
                fontWeight: 700,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: 'rgba(0,242,254,0.5)',
                marginBottom: '0.4rem',
              }}
            >
              {skipRequested && !streamReady
                ? 'TorrServer MatriX · Проверка потока'
                : 'TorrServer MatriX · Буферизация'}
            </div>
            <h2
              style={{
                fontSize: '1.3rem',
                fontWeight: 800,
                color: 'rgba(240,242,248,0.92)',
                maxWidth: '380px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {title}
            </h2>
            {skipRequested && !streamReady && (
              <p
                style={{
                  marginTop: '0.5rem',
                  fontSize: '0.78rem',
                  color: 'rgba(255,184,0,0.8)',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.4rem',
                }}
              >
                <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
                Ждём ответ сервера потока (HTTP 200)…
              </p>
            )}
          </div>

          {/* Live Stats Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '0.75rem',
              width: '100%',
              maxWidth: '380px',
              marginTop: '1.8rem',
            }}
          >
            {/* Download Speed */}
            <div
              style={{
                background: 'rgba(0,242,254,0.06)',
                border: '1px solid rgba(0,242,254,0.15)',
                borderRadius: '16px',
                padding: '1rem 1.1rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.65rem',
              }}
            >
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  background: 'rgba(0,242,254,0.12)',
                  border: '1px solid rgba(0,242,254,0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 0 12px rgba(0,242,254,0.2)',
                  flexShrink: 0,
                }}
              >
                <Zap size={16} style={{ color: '#00F2FE' }} />
              </div>
              <div>
                <div style={{ fontSize: '0.62rem', color: 'rgba(0,242,254,0.55)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Скорость</div>
                <div
                  style={{
                    fontSize: '1.15rem',
                    fontWeight: 900,
                    color: '#fff',
                    lineHeight: 1,
                    marginTop: '2px',
                  }}
                >
                  {speedMb}
                  <span style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.5)', marginLeft: '2px', fontWeight: 600 }}>MB/s</span>
                </div>
              </div>
            </div>

            {/* Active Peers */}
            <div
              style={{
                background: 'rgba(138,43,226,0.06)',
                border: '1px solid rgba(138,43,226,0.2)',
                borderRadius: '16px',
                padding: '1rem 1.1rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.65rem',
              }}
            >
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  background: 'rgba(138,43,226,0.15)',
                  border: '1px solid rgba(138,43,226,0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 0 12px rgba(138,43,226,0.25)',
                  flexShrink: 0,
                }}
              >
                <Users size={16} style={{ color: '#B57BFF' }} />
              </div>
              <div>
                <div style={{ fontSize: '0.62rem', color: 'rgba(181,123,255,0.6)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Пиры</div>
                <div style={{ fontSize: '1.15rem', fontWeight: 900, color: '#fff', lineHeight: 1, marginTop: '2px' }}>
                  {stats?.active_peers || 12}
                  <span style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', fontWeight: 600 }}>/{stats?.total_peers || 48}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Buffer Bar */}
          <div style={{ width: '100%', maxWidth: '380px', marginTop: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
              <span style={{ fontSize: '0.68rem', color: 'rgba(240,242,248,0.35)', fontWeight: 600 }}>Предзагрузка буфера</span>
              <span style={{ fontSize: '0.68rem', color: 'rgba(0,242,254,0.6)', fontWeight: 700 }}>{bufferPercent}%</span>
            </div>
            <div style={{ height: '4px', background: 'rgba(255,255,255,0.07)', borderRadius: '99px', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${bufferPercent}%`,
                  background: 'linear-gradient(90deg, #00F2FE, #8A2BE2)',
                  borderRadius: '99px',
                  boxShadow: '0 0 8px rgba(0,242,254,0.5)',
                  transition: 'width 0.5s ease',
                }}
              />
            </div>
          </div>

          {/* Skip Button — ждёт HTTP 200 от потока, не монтирует пустой <video> */}
          {!skipRequested ? (
            <button
              onClick={handleSkipBuffering}
              className="btn-secondary"
              style={{ marginTop: '1.8rem', fontSize: '0.82rem', padding: '0.6rem 1.5rem' }}
            >
              Пропустить буферизацию →
            </button>
          ) : (
            <p
              style={{
                marginTop: '1.6rem',
                fontSize: '0.72rem',
                color: 'rgba(240,242,248,0.35)',
                fontWeight: 500,
              }}
            >
              Плеер запустится сразу после ответа потока — проверка HTTP 200…
            </p>
          )}
        </div>

      ) : errorMsg ? (
        /* ════════ STATE 2: ERROR ════════ */
        <div
          style={{
            maxWidth: '400px',
            padding: '2.5rem',
            textAlign: 'center',
            background: 'rgba(11,12,17,0.9)',
            border: '1px solid rgba(255,84,112,0.3)',
            borderRadius: '24px',
          }}
        >
          <AlertTriangle size={40} style={{ color: '#FF5470', margin: '0 auto 1rem' }} />
          <h3 style={{ fontWeight: 800, fontSize: '1.1rem', marginBottom: '0.5rem', color: '#fff' }}>Ошибка вещания</h3>
          <p style={{ fontSize: '0.82rem', color: 'rgba(240,242,248,0.5)', marginBottom: '1.5rem' }}>{errorMsg}</p>
          <button onClick={handleClose} className="btn-primary" style={{ borderRadius: '12px' }}>Закрыть</button>
        </div>

      ) : (
        /* ════════ STATE 3: VIDEO PLAYER ════════ */
        <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {/* Video Element — src управляется адаптивным эффектом:
              HLS (gst m3u8) → Hls.js, обычный /stream → нативный src */}
          <video
            ref={videoRef}
            autoPlay
            crossOrigin="anonymous"
            onLoadedMetadata={handleVideoMetadata}
            onError={handleVideoError}
            onPlay={() => setIsPlaying(true)}
            onPlaying={() => setOnlineLoading(false)}
            onPause={() => setIsPlaying(false)}
            onTimeUpdate={handleTimeUpdate}
            onEnded={handleEnded}
            onClick={handleVideoClick}
            onDoubleClick={handleVideoDoubleClick}
            style={{ width: '100%', height: '100%', cursor: showControls ? 'default' : 'none', ...objectFitStyle }}
          />

          {/* Скрытый видео-элемент + canvas: превью кадров для нативных потоков
              (не участвует в воспроизведении — только seek к точке наведения) */}
          <video
            ref={captureVideoRef}
            muted
            playsInline
            style={{ position: 'absolute', width: '2px', height: '2px', opacity: 0, pointerEvents: 'none', zIndex: -1 }}
          />
          <canvas ref={captureCanvasRef} style={{ display: 'none' }} />

          {/* ── Онлайн-режим: подключение к источнику (до первого playing) ── */}
          {isOnline && onlineLoading && !isEnded && !codecError && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 54,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.75rem',
                background: 'rgba(0,0,0,0.55)',
                pointerEvents: 'none',
              }}
            >
              <Loader2 size={32} style={{ color: '#00F2FE', animation: 'spin 1s linear infinite' }} />
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'rgba(240,242,248,0.85)', letterSpacing: '0.05em' }}>
                Подключение к источнику…
              </div>
              {directQuality && (
                <div style={{ fontSize: '0.66rem', fontWeight: 600, color: 'rgba(0,242,254,0.65)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {directQuality}
                </div>
              )}
            </div>
          )}

          {/* ── HUD: всплывающий индикатор громкости ── */}
          {volumeHud !== null && (
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 55,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '1rem 1.4rem',
                borderRadius: '18px',
                background: 'rgba(10,11,14,0.88)',
                border: '1px solid rgba(0,242,254,0.25)',
                boxShadow: '0 12px 40px rgba(0,0,0,0.6), 0 0 20px rgba(0,242,254,0.08)',
                animation: 'scaleIn 0.15s cubic-bezier(0.16,1,0.3,1)',
                pointerEvents: 'none',
              }}
            >
              <span style={{ fontSize: '1.4rem', fontWeight: 900, color: '#fff', lineHeight: 1 }}>
                {volumeHud}%
              </span>
              <div style={{ width: '120px', height: '5px', background: 'rgba(255,255,255,0.15)', borderRadius: '99px', overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${volumeHud}%`,
                    height: '100%',
                    background: 'linear-gradient(90deg, #00F2FE, #8A2BE2)',
                    borderRadius: '99px',
                    transition: 'width 0.1s ease',
                  }}
                />
              </div>
              {volumeHud === 0 ? <VolumeX size={18} color="#FF5470" /> : <Volume2 size={18} color="#00F2FE" />}
            </div>
          )}

          {/* ── END SCREEN: воспроизведение завершено ── */}
          {isEnded && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 58,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0,0,0,0.94)',
                padding: '1.5rem',
              }}
            >
              <div
                style={{
                  maxWidth: '420px',
                  width: '100%',
                  padding: '2.5rem 2rem',
                  textAlign: 'center',
                  background: 'rgba(11,12,17,0.96)',
                  border: '1px solid rgba(0,242,254,0.25)',
                  borderRadius: '24px',
                  boxShadow: '0 24px 80px rgba(0,0,0,0.8)',
                  animation: 'scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)',
                }}
              >
                {poster ? (
                  <img
                    src={poster}
                    alt=""
                    style={{ width: '88px', height: '128px', objectFit: 'cover', borderRadius: '12px', margin: '0 auto 1rem', boxShadow: '0 12px 40px rgba(0,0,0,0.7), 0 0 24px rgba(0,242,254,0.18)', border: '1px solid rgba(255,255,255,0.1)' }}
                  />
                ) : (
                  <div
                    style={{
                      width: '64px',
                      height: '64px',
                      borderRadius: '50%',
                      background: 'linear-gradient(135deg, rgba(0,198,251,0.2), rgba(138,43,226,0.2))',
                      border: '1px solid rgba(0,242,254,0.3)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      margin: '0 auto 1rem',
                    }}
                  >
                    <MonitorPlay size={26} style={{ color: '#00F2FE' }} />
                  </div>
                )}
                <h3 style={{ fontWeight: 900, fontSize: '1.15rem', marginBottom: '0.4rem', color: '#fff' }}>
                  Воспроизведение завершено
                </h3>
                <p style={{ fontSize: '0.8rem', color: 'rgba(240,242,248,0.55)', marginBottom: '1.4rem', lineHeight: 1.5 }}>
                  Прогресс сохранён в историю просмотра.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  {nextEpisode && onPlayNext && (
                    <button
                      onClick={() => { onPlayNext(); }}
                      className="btn-primary"
                      style={{ borderRadius: '12px', padding: '0.7rem', fontSize: '0.85rem' }}
                    >
                      <SkipForward size={15} style={{ marginRight: '0.4rem' }} />
                      Следующая серия · S{nextEpisode.season}E{nextEpisode.episode}
                    </button>
                  )}
                  <button
                    onClick={() => { setIsEnded(false); if (videoRef.current) { videoRef.current.currentTime = 0; videoRef.current.play(); } }}
                    className={nextEpisode && onPlayNext ? 'btn-secondary' : 'btn-primary'}
                    style={{ borderRadius: '12px', padding: '0.7rem', fontSize: '0.85rem' }}
                  >
                    <RotateCcw size={15} style={{ marginRight: '0.4rem' }} />
                    Смотреть сначала
                  </button>
                  <button
                    onClick={handleClose}
                    className="btn-secondary"
                    style={{ borderRadius: '12px', padding: '0.7rem', fontSize: '0.85rem' }}
                  >
                    Закрыть
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── CODEC ERROR OVERLAY: неподдерживаемый формат / зависший поток ── */}
          {/* Оверлей ошибки кодека — только если видео ДЕЙСТВИТЕЛЬНО не играет
              (не в состоянии playing). Если поток пошёл — оверлей мгновенно уходит. */}
          {codecError && !isPlaying && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 60,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0,0,0,0.94)',
                padding: '1.5rem',
              }}
            >
              <div
                style={{
                  maxWidth: '460px',
                  width: '100%',
                  padding: '2.5rem 2rem',
                  textAlign: 'center',
                  background: 'rgba(11,12,17,0.96)',
                  border: '1px solid rgba(255,184,0,0.35)',
                  borderRadius: '24px',
                  boxShadow: '0 24px 80px rgba(0,0,0,0.8), 0 0 30px rgba(255,184,0,0.06)',
                  animation: 'scaleIn 0.25s cubic-bezier(0.16,1,0.3,1)',
                }}
              >
                <AlertTriangle size={42} style={{ color: '#FFB800', margin: '0 auto 1rem' }} />
                <h3 style={{ fontWeight: 900, fontSize: '1.15rem', marginBottom: '0.6rem', color: '#fff' }}>
                  Неподдерживаемый формат видео/кодек
                </h3>
                <p style={{ fontSize: '0.85rem', color: 'rgba(240,242,248,0.6)', lineHeight: 1.6, marginBottom: '0.9rem' }}>
                  Встроенный плеер не смог воспроизвести этот поток.
                  {mediaErrorDetail && (
                    <span style={{ color: 'rgba(255,184,0,0.85)', fontWeight: 700 }}> {mediaErrorDetail}. </span>
                  )}
                  {codecRisk.risky && (
                    <> Поток: {codecRisk.ext.toUpperCase()} · {codecRisk.video} · {codecRisk.audio}. </>
                  )}
                  Откройте его через VLC или IINA.
                </p>
                {codecRisk.risky && (
                  <div
                    style={{
                      display: 'inline-flex',
                      gap: '0.4rem',
                      marginBottom: '1.4rem',
                      padding: '0.35rem 0.8rem',
                      borderRadius: '999px',
                      background: 'rgba(255,184,0,0.1)',
                      border: '1px solid rgba(255,184,0,0.3)',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      color: '#FFB800',
                    }}
                  >
                    {codecRisk.ext.toUpperCase()} · {codecRisk.video} · {codecRisk.audio}
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <button
                    onClick={openExternalPlayer}
                    className="btn-primary"
                    style={{ borderRadius: '12px', padding: '0.7rem 1rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}
                  >
                    <ExternalLink size={15} />
                    Открыть во внешнем плеере (VLC / IINA)
                  </button>
                  <div style={{ display: 'flex', gap: '0.6rem' }}>
                    <button
                      onClick={() => setCodecError(false)}
                      className="btn-secondary"
                      style={{ flex: 1, borderRadius: '12px', padding: '0.55rem', fontSize: '0.8rem' }}
                    >
                      Продолжить ожидание
                    </button>
                    <button
                      onClick={handleClose}
                      className="btn-secondary"
                      style={{ flex: 1, borderRadius: '12px', padding: '0.55rem', fontSize: '0.8rem' }}
                    >
                      Закрыть
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── CUSTOM CONTROLS OVERLAY ── */}
          <div
            onClick={handleVideoClick}
            onDoubleClick={handleVideoDoubleClick}
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              opacity: showControls ? 1 : 0,
              transform: showControls ? 'translateY(0)' : 'translateY(18px)',
              transition: 'opacity 0.35s ease, transform 0.4s cubic-bezier(0.16,1,0.3,1)',
              pointerEvents: showControls ? 'auto' : 'none',
            }}
          >
            {/* Bottom gradient backdrop — position:relative, чтобы выпадающая
                панель настроек (bottom:100%) открывалась НАД панелью, а не
                уходила за нижний край экрана. Стекло (blur) — как у лидеров. */}
            <div
              data-player-controls
              style={{
                position: 'relative',
                background: 'linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.55) 60%, transparent 100%)',
                WebkitBackdropFilter: 'blur(16px) saturate(150%)',
                backdropFilter: 'blur(16px) saturate(150%)',
                padding: '0 1.5rem 1.5rem',
              }}
            >
              {/* Top Info Row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.3rem' }}>
                <span style={{ fontSize: '0.88rem', fontWeight: 700, color: 'rgba(255,255,255,0.9)' }}>{title}</span>
                <div style={{ display: 'flex', gap: '1rem', fontSize: '0.72rem', fontWeight: 600, color: 'rgba(255,255,255,0.4)', flexWrap: 'wrap' }}>
                  {codecRisk.risky && (
                    <span
                      title="MKV / HEVC / AC3 могут не воспроизводиться в Chromium. При проблемах откройте поток через VLC."
                      style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', color: '#FFB800', fontWeight: 700 }}
                    >
                      <AlertTriangle size={12} />
                      {codecRisk.ext.toUpperCase()} · {codecRisk.video} · {codecRisk.audio}
                    </span>
                  )}
                  {audioTrackLabel && (
                    <span style={{ color: 'rgba(16,245,172,0.7)' }}>🔊 {audioTrackLabel}</span>
                  )}
                  {/* Онлайн: качество. Торрент: скорость + пиры */}
                  {isOnline ? (
                    <span style={{ color: 'rgba(0,242,254,0.7)' }}>{currentQualityLabel}</span>
                  ) : (
                    <>
                      <span style={{ color: 'rgba(0,242,254,0.7)' }}>{speedMb} MB/s</span>
                      <span>{stats?.active_peers || 0} peers</span>
                    </>
                  )}
                  <span>{formatTime(currentTime)} / {formatTime(duration)}</span>
                </div>
              </div>

              {/* Progress / Seek Bar */}
              <div
                ref={progressRef}
                data-seekbar
                tabIndex={0}
                role="slider"
                aria-label="Прогресс воспроизведения"
                aria-valuemin={0}
                aria-valuemax={Math.floor(duration)}
                aria-valuenow={Math.floor(currentTime)}
                onClick={handleSeek}
                onMouseMove={handleScrubHover}
                onMouseLeave={() => { setScrubHover(null); setScrubPreviewImg(null); if (scrubPreviewTimer.current) clearTimeout(scrubPreviewTimer.current); }}
                onKeyDown={(e) => {
                  // Клавиатура/пульт на seek-баре: Left/Right — перемотка, Up/Down — громкость
                  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault(); e.stopPropagation();
                    skipSeconds(e.key === 'ArrowLeft' ? -10 : 10);
                  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault(); e.stopPropagation();
                    setVolumeLevel(e.key === 'ArrowUp' ? Math.min(1, volume + 0.05) : Math.max(0, volume - 0.05));
                  } else if (e.key === 'Home' || e.key === 'End') {
                    e.preventDefault(); e.stopPropagation();
                    const v = videoRef.current;
                    if (v) v.currentTime = e.key === 'Home' ? 0 : (v.duration || 0);
                  }
                }}
                style={{
                  position: 'relative',
                  height: '20px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  marginBottom: '0.6rem',
                }}
              >
                {/* Scrubber tooltip: время под курсором (+ превью-кадр для нативных потоков) */}
                {scrubHover && (
                  <div
                    style={{
                      position: 'absolute',
                      bottom: '30px',
                      left: `${scrubHover.x}px`,
                      transform: 'translateX(-50%)',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '4px',
                      padding: scrubPreviewImg ? '4px 4px 6px' : '2px 8px',
                      borderRadius: '10px',
                      background: 'rgba(10,11,14,0.9)',
                      border: '1px solid rgba(0,242,254,0.25)',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.5), 0 0 12px rgba(0,242,254,0.08)',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      color: '#00F2FE',
                      pointerEvents: 'none',
                      whiteSpace: 'nowrap',
                      zIndex: 5,
                    }}
                  >
                    {scrubPreviewImg && (
                      <img
                        src={scrubPreviewImg}
                        alt=""
                        style={{ width: '168px', borderRadius: '6px', objectFit: 'contain', background: '#000' }}
                      />
                    )}
                    <span>{formatTime(scrubHover.time)}</span>
                  </div>
                )}
                {/* Track */}
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    height: '4px',
                    background: 'rgba(255,255,255,0.12)',
                    borderRadius: '99px',
                    overflow: 'visible',
                  }}
                >
                  {/* Buffered */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: `${bufferedPercent}%`,
                      background: 'rgba(255,255,255,0.2)',
                      borderRadius: '99px',
                      transition: 'width 0.3s ease',
                    }}
                  />
                  {/* Played */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: `${progressPercent}%`,
                      background: 'linear-gradient(90deg, #00F2FE, #8A2BE2)',
                      borderRadius: '99px',
                      boxShadow: '0 0 10px rgba(0,242,254,0.6)',
                      transition: 'width 0.1s linear',
                    }}
                  />
                  {/* Thumb */}
                  <div
                    style={{
                      position: 'absolute',
                      left: `${progressPercent}%`,
                      top: '50%',
                      width: '14px',
                      height: '14px',
                      borderRadius: '50%',
                      background: '#fff',
                      transform: 'translate(-50%, -50%)',
                      boxShadow: '0 0 10px rgba(0,242,254,0.8), 0 0 20px rgba(0,242,254,0.4)',
                      transition: 'left 0.1s linear',
                    }}
                  />
                </div>
              </div>

              {/* Controls Row */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {/* Video Filters / Settings Toggle */}
                <button
                  data-filters-toggle
                  onClick={(e) => {
                    // stopPropagation: клик по кнопке не должен «уходить» к видео
                    // (клик по экрану = play/pause) и сразу закрываться
                    e.stopPropagation();
                    const next = !showFilters;
                    setShowFilters(next);
                    if (next) setFiltersPage('root'); // открываем со списка разделов
                  }}
                  className="btn-icon"
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '10px',
                    background: showFilters ? 'rgba(0,242,254,0.15)' : undefined,
                    border: showFilters ? '1px solid rgba(0,242,254,0.35)' : undefined,
                    zIndex: 60,
                    pointerEvents: 'auto',
                  }}
                  title="Настройки и фильтры"
                >
                  <SlidersHorizontal size={15} style={{ color: showFilters ? 'var(--cyan)' : undefined }} />
                </button>

                {/* Picture-in-Picture */}
                <button
                  onClick={togglePip}
                  className="btn-icon"
                  title="Картинка в картинке"
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '10px',
                    background: isPip ? 'rgba(0,242,254,0.15)' : undefined,
                    border: isPip ? '1px solid rgba(0,242,254,0.35)' : undefined,
                  }}
                >
                  <PictureInPicture2 size={15} style={{ color: isPip ? 'var(--cyan)' : undefined }} />
                </button>


                {/* Открыть во внешнем плеере (IINA / VLC) — прямой /stream TorrServer */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    videoRef.current?.pause();
                    openExternalPlayer();
                  }}
                  className="btn-icon"
                  title="Открыть в IINA / VLC (внешний плеер macOS)"
                  style={{ width: '36px', height: '36px', borderRadius: '10px' }}
                >
                  <ExternalLink size={15} />
                </button>

                {/* Fullscreen */}
                <button
                  onClick={toggleFullscreen}
                  className="btn-icon"
                  title="Полный экран (F)"
                  style={{ width: '36px', height: '36px', borderRadius: '10px' }}
                >
                  {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
                </button>
                </div>

                {/* Center Controls → right-aligned */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {/* Skip Back */}
                  <button
                    onClick={() => skipSeconds(-10)}
                    className="btn-icon"
                    style={{ width: '36px', height: '36px', borderRadius: '10px' }}
                    title="-10 сек"
                  >
                    <SkipBack size={15} />
                  </button>

                  {/* Play / Pause */}
                  <button
                    onClick={togglePlay}
                    style={{
                      width: '44px',
                      height: '44px',
                      borderRadius: '50%',
                      background: 'linear-gradient(135deg, #00c6fb, #8A2BE2)',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      boxShadow: '0 0 20px rgba(0,198,251,0.4)',
                      transition: 'all 0.2s ease',
                      color: '#fff',
                    }}
                  >
                    {isPlaying
                      ? <Pause size={18} fill="white" />
                      : <Play  size={18} fill="white" style={{ marginLeft: '2px' }} />
                    }
                  </button>

                  {/* Skip Forward */}
                  <button
                    onClick={() => skipSeconds(10)}
                    className="btn-icon"
                    style={{ width: '36px', height: '36px', borderRadius: '10px' }}
                    title="+10 сек"
                  >
                    <SkipForward size={15} />
                  </button>

                  {/* Volume Controls */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginLeft: '0.25rem' }}>
                    <button
                      onClick={toggleMute}
                      className="btn-icon"
                      style={{ width: '34px', height: '34px', borderRadius: '9px' }}
                    >
                      {isMuted || volume === 0
                        ? <VolumeX size={15} />
                        : <Volume2 size={15} />
                      }
                    </button>
                    <div style={{ position: 'relative', width: '80px', height: '20px', display: 'flex', alignItems: 'center' }}>
                      <div style={{ position: 'absolute', left: 0, right: 0, height: '4px', background: 'rgba(255,255,255,0.12)', borderRadius: '99px' }}>
                        <div style={{ width: `${(isMuted ? 0 : volume) * 100}%`, height: '100%', background: 'linear-gradient(90deg, #00F2FE, #4facfe)', borderRadius: '99px', boxShadow: '0 0 8px rgba(0,242,254,0.5)', transition: 'width 0.1s' }} />
                      </div>
                      <input
                        type="range" min="0" max="1" step="0.02"
                        value={isMuted ? 0 : volume}
                        onChange={e => setVolumeLevel(parseFloat(e.target.value))}
                        className="neon-slider"
                        style={{ position: 'absolute', left: 0, right: 0, opacity: 0.01, width: '100%', cursor: 'pointer' }}
                      />
                    </div>
                  </div>

                  {/* ── Качество (онлайн-режим): уровни из HLS-манифеста ── */}
                  {isOnline && hlsLevels.length > 0 && (
                    <div ref={qualityRef} style={{ position: 'relative' }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setShowQuality(s => !s); }}
                        className="btn-icon"
                        title="Качество"
                        style={{
                          height: '36px',
                          padding: '0 0.6rem',
                          borderRadius: '10px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.3rem',
                          fontSize: '0.72rem',
                          fontWeight: 700,
                          color: showQuality ? 'var(--cyan)' : undefined,
                          background: showQuality ? 'rgba(0,242,254,0.15)' : undefined,
                          border: showQuality ? '1px solid rgba(0,242,254,0.35)' : undefined,
                        }}
                      >
                        <MonitorPlay size={14} />
                        {currentQualityLabel}
                        <ChevronDown size={13} style={{ opacity: 0.7 }} />
                      </button>
                      {showQuality && (
                        <div
                          style={{
                            position: 'absolute',
                            bottom: '100%',
                            right: 0,
                            marginBottom: '0.5rem',
                            minWidth: '130px',
                            padding: '0.4rem',
                            borderRadius: '12px',
                            background: 'rgba(14,15,21,0.97)',
                            border: '1px solid rgba(0,242,254,0.2)',
                            boxShadow: '0 8px 40px rgba(0,0,0,0.8), 0 0 20px rgba(0,242,254,0.08)',
                            animation: 'scaleIn 0.2s cubic-bezier(0.16,1,0.3,1)',
                            zIndex: 70,
                            pointerEvents: 'auto',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '2px',
                          }}
                        >
                          <button
                            onClick={(e) => { e.stopPropagation(); selectQuality(-1); }}
                            style={{
                              ...qualityItemStyle,
                              color: qualityAuto ? 'var(--cyan)' : 'var(--text-muted)',
                              background: qualityAuto ? 'rgba(0,242,254,0.12)' : 'transparent',
                              border: qualityAuto ? '1px solid rgba(0,242,254,0.35)' : '1px solid transparent',
                            }}
                          >
                            {qualityAuto && <Check size={11} />} Авто
                          </button>
                          {hlsLevels.map((lv) => {
                            const active = !qualityAuto && currentLevel === lv.index;
                            return (
                              <button
                                key={lv.index}
                                onClick={(e) => { e.stopPropagation(); selectQuality(lv.index); }}
                                style={{
                                  ...qualityItemStyle,
                                  color: active ? 'var(--cyan)' : 'var(--text-muted)',
                                  background: active ? 'rgba(0,242,254,0.12)' : 'transparent',
                                  border: active ? '1px solid rgba(0,242,254,0.35)' : '1px solid transparent',
                                }}
                              >
                                {active && <Check size={11} />} {lv.label}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* ── Settings Panel: страницы параметров (Изображение / Масштаб /
                  Скорость / Аудио / Субтитры) — вместо одного развёрнутого списка ── */}
              {showFilters && (
                <div
                  ref={filtersPanelRef}
                  style={{
                    position: 'absolute',
                    bottom: '100%',
                    left: '0.5rem',
                    right: 'auto',
                    marginBottom: '0.75rem',
                    background: 'rgba(14,15,21,0.97)',
                    border: '1px solid rgba(0,242,254,0.2)',
                    borderRadius: '18px',
                    width: '300px',
                    maxHeight: 'min(62vh, 430px)',
                    display: 'flex',
                    flexDirection: 'column',
                    boxShadow: '0 8px 40px rgba(0,0,0,0.8), 0 0 20px rgba(0,242,254,0.08)',
                    animation: 'scaleIn 0.2s cubic-bezier(0.16,1,0.3,1)',
                    zIndex: 70,
                    pointerEvents: 'auto',
                    overflow: 'hidden',
                  }}
                >
                  {/* Header: назад / заголовок страницы / сброс */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.9rem 1rem 0.5rem' }}>
                    {filtersPage !== 'root' ? (
                      <button
                        onClick={() => setFiltersPage('root')}
                        className="btn-icon"
                        title="Все параметры"
                        style={{ width: '26px', height: '26px', borderRadius: '8px', flexShrink: 0 }}
                      >
                        <ChevronLeft size={14} />
                      </button>
                    ) : null}
                    <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--cyan)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      {filtersPageTitle}
                    </span>
                    <div style={{ flex: 1 }} />
                    {filtersPage === 'image' && (
                      <button
                        onClick={resetFilters}
                        style={{
                          fontSize: '0.66rem',
                          fontWeight: 700,
                          color: 'var(--text-muted)',
                          background: 'rgba(255,255,255,0.06)',
                          border: '1px solid rgba(255,255,255,0.1)',
                          borderRadius: '8px',
                          padding: '3px 10px',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Сброс
                      </button>
                    )}
                  </div>

                  {/* Content: одна страница параметров за раз */}
                  <div
                    key={filtersPage}
                    style={{
                      padding: '0.4rem 1rem 1rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.75rem',
                      overflowY: 'auto',
                      scrollbarWidth: 'thin',
                      animation: 'fadeIn 0.18s ease',
                    }}
                  >
                    {filtersPage === 'root' && (
                      <>
                        {settingsRow(<Sun size={14} />, 'Изображение', 'image')}
                        {settingsRow(<Maximize size={14} />, 'Масштаб', 'scale')}
                        {settingsRow(<Gauge size={14} />, 'Скорость', 'speed')}
                        {displayAudioTracks.length > 0 && settingsRow(<AudioLines size={14} />, 'Аудиодорожка', 'audio')}
                        {settingsRow(<Subtitles size={14} />, 'Субтитры', 'subs')}
                      </>
                    )}

                    {filtersPage === 'image' && (
                      <>

                  {/* Brightness */}
                  <FilterSlider
                    icon={<Sun size={13} />}
                    label="Яркость"
                    value={filters.brightness}
                    min={0.5} max={1.5} step={0.05}
                    onChange={v => setFilters(f => ({ ...f, brightness: v }))}
                  />

                  {/* Contrast */}
                  <FilterSlider
                    icon={<Contrast size={13} />}
                    label="Контраст"
                    value={filters.contrast}
                    min={0.5} max={1.5} step={0.05}
                    onChange={v => setFilters(f => ({ ...f, contrast: v }))}
                  />

                  {/* Saturation */}
                  <FilterSlider
                    icon={<Palette size={13} />}
                    label="Насыщенность"
                    value={filters.saturation}
                    min={0} max={2} step={0.05}
                    onChange={v => setFilters(f => ({ ...f, saturation: v }))}
                  />

                  {/* Grayscale Toggle */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                      <Monitor size={13} style={{ color: 'var(--text-muted)' }} />
                      <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Ч/Б</span>
                    </div>
                    <button
                      onClick={() => setFilters(f => ({ ...f, grayscale: !f.grayscale }))}
                      style={{
                        width: '42px',
                        height: '24px',
                        borderRadius: '12px',
                        border: 'none',
                        background: filters.grayscale
                          ? 'linear-gradient(135deg, rgba(0,198,251,0.5), rgba(138,43,226,0.4))'
                          : 'rgba(255,255,255,0.12)',
                        cursor: 'pointer',
                        position: 'relative',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      <div style={{
                        position: 'absolute',
                        top: '2px',
                        left: filters.grayscale ? '22px' : '2px',
                        width: '20px',
                        height: '20px',
                        borderRadius: '50%',
                        background: '#fff',
                        transition: 'left 0.2s cubic-bezier(0.34,1.56,0.64,1)',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                      }} />
                    </button>
                  </div>
                    </>
                    )}
                    {filtersPage === 'scale' && (
                    <>
                  {/* Aspect Ratio / Scaling */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                      <Maximize size={13} style={{ color: 'var(--text-muted)' }} />
                      <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Масштаб</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.35rem' }}>
                      {([
                        { key: 'contain', label: 'По экрану' },
                        { key: 'cover',   label: 'Заполнить' },
                        { key: 'fill',    label: 'Растянуть' },
                        { key: '16:9',    label: '16:9' },
                        { key: '21:9',    label: '21:9 UW' },
                        { key: '4:3',     label: '4:3' },
                      ] as const).map(({ key, label }) => (
                        <button
                          key={key}
                          onClick={() => setFilters(f => ({ ...f, aspectRatio: key }))}
                          style={{
                            padding: '0.4rem 0.3rem',
                            borderRadius: '8px',
                            border: `1px solid ${filters.aspectRatio === key ? 'rgba(0,242,254,0.4)' : 'rgba(255,255,255,0.08)'}`,
                            background: filters.aspectRatio === key ? 'rgba(0,242,254,0.12)' : 'rgba(255,255,255,0.03)',
                            color: filters.aspectRatio === key ? 'var(--cyan)' : 'var(--text-muted)',
                            fontSize: '0.68rem',
                            fontWeight: 700,
                            fontFamily: 'inherit',
                            cursor: 'pointer',
                            textAlign: 'center',
                            transition: 'all 0.15s ease',
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                    </>
                    )}
                    {filtersPage === 'speed' && (
                    <>
                  {/* Скорость воспроизведения */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                      <Gauge size={13} style={{ color: 'var(--text-muted)' }} />
                      <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Скорость</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.3rem' }}>
                      {[0.5, 1, 1.25, 1.5, 2].map((r) => (
                        <button
                          key={r}
                          onClick={() => setPlaybackRate(r)}
                          style={{
                            padding: '0.35rem 0.1rem',
                            borderRadius: '8px',
                            border: `1px solid ${playbackRate === r ? 'rgba(0,242,254,0.4)' : 'rgba(255,255,255,0.08)'}`,
                            background: playbackRate === r ? 'rgba(0,242,254,0.12)' : 'rgba(255,255,255,0.03)',
                            color: playbackRate === r ? 'var(--cyan)' : 'var(--text-muted)',
                            fontSize: '0.68rem',
                            fontWeight: 700,
                            fontFamily: 'inherit',
                            cursor: 'pointer',
                            textAlign: 'center',
                          }}
                        >
                          {r}x
                        </button>
                      ))}
                    </div>
                  </div>
                    </>
                    )}
                    {filtersPage === 'audio' && displayAudioTracks.length > 0 && (
                    <>
                  {/* ── Аудиодорожка: языки и студии озвучки из контейнера ── */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                        <AudioLines size={13} style={{ color: 'var(--text-muted)' }} />
                        <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Аудиодорожка</span>
                      </div>
                      <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                        {displayAudioTracks.map((t) => {
                          const isActive = activeAudioTrack === t.index;
                          return (
                            <button
                              key={t.index}
                              onClick={() => selectAudioTrack(t.index)}
                              title={
                                mkvTracks.length > 1 && mkvTracks[t.index]
                                  ? `${t.label} · кодек ${mkvTracks[t.index].codec}`
                                  : t.label
                              }
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.3rem',
                                padding: '0.32rem 0.6rem',
                                borderRadius: '8px',
                                border: `1px solid ${isActive ? 'rgba(138,43,226,0.5)' : 'rgba(255,255,255,0.08)'}`,
                                background: isActive ? 'rgba(138,43,226,0.15)' : 'rgba(255,255,255,0.03)',
                                color: isActive ? '#B57BFF' : 'var(--text-muted)',
                                fontSize: '0.68rem',
                                fontWeight: 700,
                                fontFamily: 'inherit',
                                cursor: 'pointer',
                                maxWidth: '170px',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {isActive && <Check size={11} style={{ flexShrink: 0 }} />}
                              {t.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    </>
                    )}
                    {filtersPage === 'subs' && (
                    <>
                  {/* Субтитры */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                        <Subtitles size={13} style={{ color: 'var(--text-muted)' }} />
                        <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Субтитры</span>
                      </div>
                      <button
                        onClick={() => setSubs(s => ({ ...s, enabled: !s.enabled }))}
                        style={{
                          padding: '2px 10px',
                          borderRadius: '999px',
                          border: `1px solid ${subs.enabled ? 'rgba(0,242,254,0.4)' : 'rgba(255,255,255,0.1)'}`,
                          background: subs.enabled ? 'rgba(0,242,254,0.12)' : 'rgba(255,255,255,0.03)',
                          color: subs.enabled ? 'var(--cyan)' : 'var(--text-muted)',
                          fontSize: '0.66rem',
                          fontWeight: 800,
                          fontFamily: 'inherit',
                          cursor: 'pointer',
                        }}
                      >
                        {subs.enabled ? 'Вкл' : 'Выкл'}
                      </button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                      {/* Размер */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontSize: '0.64rem', color: 'var(--text-muted)', minWidth: '56px' }}>Размер</span>
                        <div style={{ flex: 1, display: 'flex', gap: '0.25rem' }}>
                          {[80, 100, 130, 160].map((sz) => (
                            <button
                              key={sz}
                              onClick={() => setSubs(s => ({ ...s, size: sz }))}
                              style={{
                                flex: 1,
                                padding: '0.25rem 0',
                                borderRadius: '6px',
                                border: `1px solid ${subs.size === sz ? 'rgba(0,242,254,0.4)' : 'rgba(255,255,255,0.08)'}`,
                                background: subs.size === sz ? 'rgba(0,242,254,0.12)' : 'transparent',
                                color: subs.size === sz ? 'var(--cyan)' : 'var(--text-muted)',
                                fontSize: '0.62rem',
                                fontWeight: 700,
                                fontFamily: 'inherit',
                                cursor: 'pointer',
                              }}
                            >
                              {sz === 100 ? '100%' : `${sz}%`}
                            </button>
                          ))}
                        </div>
                      </div>
                      {/* Цвет */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontSize: '0.64rem', color: 'var(--text-muted)', minWidth: '56px' }}>Цвет</span>
                        <div style={{ display: 'flex', gap: '0.3rem' }}>
                          {['#FFFFFF', '#FFB800', '#00F2FE', '#10F5AC', '#FF5470'].map((c) => (
                            <button
                              key={c}
                              onClick={() => setSubs(s => ({ ...s, color: c }))}
                              title={c}
                              style={{
                                width: '18px',
                                height: '18px',
                                borderRadius: '50%',
                                background: c,
                                border: `2px solid ${subs.color === c ? 'rgba(0,242,254,0.8)' : 'rgba(255,255,255,0.15)'}`,
                                cursor: 'pointer',
                              }}
                            />
                          ))}
                        </div>
                      </div>
                      {/* Задержка синхронизации */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontSize: '0.64rem', color: 'var(--text-muted)', minWidth: '56px' }}>Задержка</span>
                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                          <button
                            onClick={() => setSubs(s => ({ ...s, delay: Math.max(-30, s.delay - 0.5) }))}
                            className="btn-icon"
                            style={{ width: '26px', height: '26px', borderRadius: '8px', fontSize: '0.8rem' }}
                          >−</button>
                          <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-primary)', minWidth: '52px', textAlign: 'center' }}>
                            {subs.delay === 0 ? '0с' : `${subs.delay > 0 ? '+' : ''}${subs.delay}с`}
                          </span>
                          <button
                            onClick={() => setSubs(s => ({ ...s, delay: Math.min(30, s.delay + 0.5) }))}
                            className="btn-icon"
                            style={{ width: '26px', height: '26px', borderRadius: '8px', fontSize: '0.8rem' }}
                          >+</button>
                        </div>
                      </div>
                    </div>
                  </div>
                    </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
