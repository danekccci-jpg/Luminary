import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  X, Play, Pause, Volume2, VolumeX,
  Maximize, Minimize, Zap, Users,
  AlertTriangle, SkipBack, SkipForward,
  SlidersHorizontal, Sun, Contrast, Palette, Monitor,
} from 'lucide-react';
import { TorrServerStats } from '../types';
import { torrServerService } from '../services/torrserver';

interface PlayerModalProps {
  magnet: string;
  title: string;
  poster?: string;
  /** Prefer AAC/MP3 track or GST HLS remux for AC3/DTS */
  audioCodec?: string;
  transcodeAudioToAac?: boolean;
  onClose: () => void;
}

// ── Video Filter Preset ──
interface VideoFilters {
  brightness: number;  // 0.5 – 1.5 (default 1)
  contrast: number;    // 0.5 – 1.5 (default 1)
  saturation: number;  // 0.0 – 2.0 (default 1)
  grayscale: boolean;
  aspectRatio: '16:9' | '21:9' | 'fill' | 'fit';
}

const DEFAULT_FILTERS: VideoFilters = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  grayscale: false,
  aspectRatio: 'fit',
};

const FILTER_STORAGE_KEY = 'luminary_video_filters';

function loadSavedFilters(): VideoFilters {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_FILTERS, ...parsed };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_FILTERS };
}

function saveFilters(filters: VideoFilters) {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
  } catch { /* ignore */ }
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
  magnet, title, poster, audioCodec, transcodeAudioToAac = true, onClose,
}) => {
  const videoRef     = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressRef  = useRef<HTMLDivElement>(null);
  const controlsTimerRef = useRef<NodeJS.Timeout | null>(null);

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

  // ── Video Filters ──
  const [filters, setFilters]       = useState<VideoFilters>(loadSavedFilters);
  const [showFilters, setShowFilters] = useState(false);

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
      case 'fill':  return { objectFit: 'cover' };
      case '16:9':  return { objectFit: 'contain', aspectRatio: '16/9' };
      case '21:9':  return { objectFit: 'contain', aspectRatio: '21/9' };
      default:      return { objectFit: 'contain' };
    }
  })();

  const resetFilters = () => {
    setFilters({ ...DEFAULT_FILTERS });
    setShowFilters(false);
  };

  // Pre-buffer target (80 MB) — clamp progress to 0–100, never divide by zero
  const PREBUFFER_BYTES = 80 * 1024 * 1024;

  // Init torrent
  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;
    let cancelled = false;
    let stillBuffering = true;

    const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

    const init = async () => {
      try {
        const addRes = await torrServerService.addMagnet(magnet, title, poster);
        if (!addRes.success && !addRes.data) throw new Error(addRes.error || 'Ошибка добавления торрента');

        const torrentHash = addRes.data?.hash || 'demo-hash-12345';
        setHash(torrentHash);

        const url = await torrServerService.getStreamUrl(torrentHash, undefined, transcodeAudioToAac);
        if (!cancelled) setStreamUrl(url);

        intervalId = setInterval(async () => {
          if (cancelled) return;
          try {
            const statRes = await torrServerService.getTorrentStats(torrentHash);
            if (statRes.success && statRes.data) {
              const st = statRes.data;
              setStats(st);
              const loaded = Number.isFinite(st.loaded_size) ? Math.max(0, st.loaded_size) : 0;
              const denom = Math.max(1, PREBUFFER_BYTES);
              const pct = clampPct((loaded / denom) * 100);
              setBufPercent(pct);
              if (stillBuffering && (st.stat === 2 || loaded > 12 * 1024 * 1024 || pct >= 100)) {
                stillBuffering = false;
                setIsBuffering(false);
              }
            }
          } catch {
            /* poll errors are non-fatal during buffer */
          }
        }, 1000);

        setTimeout(() => {
          if (!cancelled && stillBuffering) {
            stillBuffering = false;
            setIsBuffering(false);
          }
        }, 4200);
      } catch (err: any) {
        if (!cancelled) { setErrorMsg(err.message); setIsBuffering(false); }
      }
    };

    init();
    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [magnet, title, poster, transcodeAudioToAac]);

  const handleClose = () => {
    if (hash) torrServerService.dropCache(hash);
    onClose();
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    setCurrentTime(videoRef.current.currentTime);
    setDuration(videoRef.current.duration || 0);
    if (videoRef.current.buffered.length > 0) {
      setBuffered(videoRef.current.buffered.end(videoRef.current.buffered.length - 1));
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
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) { videoRef.current.pause(); setIsPlaying(false); }
    else { videoRef.current.play(); setIsPlaying(true); }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || !videoRef.current || !duration) return;
    const rect = progressRef.current.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const time = ratio * duration;
    videoRef.current.currentTime = Math.max(0, Math.min(duration, time));
    setCurrentTime(time);
  };

  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 3500);
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

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
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
      {/* ── Top Close Button ── */}
      <div
        style={{
          position: 'absolute',
          top: '1.25rem',
          right: '1.25rem',
          zIndex: 50,
          opacity: showControls || isBuffering ? 1 : 0,
          transition: 'opacity 0.3s ease',
          pointerEvents: showControls || isBuffering ? 'auto' : 'none',
        }}
      >
        <button
          onClick={handleClose}
          style={{
            width: '42px',
            height: '42px',
            borderRadius: '50%',
            background: 'rgba(10,11,14,0.8)',
            backdropFilter: 'blur(10px)',
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
          STATE 1: FUTURISTIC BUFFERING SCREEN
          ════════════════════════════════════════ */}
      {isBuffering ? (
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
              TorrServer MatriX · Буферизация
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

          {/* Skip Button */}
          <button
            onClick={() => setIsBuffering(false)}
            className="btn-secondary"
            style={{ marginTop: '1.8rem', fontSize: '0.82rem', padding: '0.6rem 1.5rem' }}
          >
            Пропустить буферизацию →
          </button>
        </div>

      ) : errorMsg ? (
        /* ════════ STATE 2: ERROR ════════ */
        <div
          style={{
            maxWidth: '400px',
            padding: '2.5rem',
            textAlign: 'center',
            background: 'rgba(11,12,17,0.9)',
            backdropFilter: 'blur(20px)',
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
          {/* Video Element */}
          <video
            ref={videoRef}
            src={streamUrl}
            autoPlay
            crossOrigin="anonymous"
            onLoadedMetadata={handleVideoMetadata}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onTimeUpdate={handleTimeUpdate}
            onClick={togglePlay}
            style={{ width: '100%', height: '100%', cursor: showControls ? 'default' : 'none', ...objectFitStyle }}
          />

          {/* ── CUSTOM CONTROLS OVERLAY ── */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              opacity: showControls ? 1 : 0,
              transition: 'opacity 0.35s ease',
              pointerEvents: showControls ? 'auto' : 'none',
            }}
          >
            {/* Bottom gradient backdrop */}
            <div
              style={{
                background: 'linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.6) 60%, transparent 100%)',
                padding: '0 1.5rem 1.5rem',
              }}
            >
              {/* Top Info Row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.3rem' }}>
                <span style={{ fontSize: '0.88rem', fontWeight: 700, color: 'rgba(255,255,255,0.9)' }}>{title}</span>
                <div style={{ display: 'flex', gap: '1rem', fontSize: '0.72rem', fontWeight: 600, color: 'rgba(255,255,255,0.4)', flexWrap: 'wrap' }}>
                  {audioTrackLabel && (
                    <span style={{ color: 'rgba(16,245,172,0.7)' }}>🔊 {audioTrackLabel}</span>
                  )}
                  <span style={{ color: 'rgba(0,242,254,0.7)' }}>{speedMb} MB/s</span>
                  <span>{stats?.active_peers || 0} peers</span>
                  <span>{formatTime(currentTime)} / {formatTime(duration)}</span>
                </div>
              </div>

              {/* Progress / Seek Bar */}
              <div
                ref={progressRef}
                onClick={handleSeek}
                style={{
                  position: 'relative',
                  height: '20px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  marginBottom: '0.6rem',
                }}
              >
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
                {/* Left Controls */}
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
                </div>

                {/* Video Filters Toggle */}
                <button
                  onClick={() => setShowFilters(!showFilters)}
                  className="btn-icon"
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '10px',
                    background: showFilters ? 'rgba(0,242,254,0.15)' : undefined,
                    border: showFilters ? '1px solid rgba(0,242,254,0.35)' : undefined,
                  }}
                  title="Фильтры изображения"
                >
                  <SlidersHorizontal size={15} style={{ color: showFilters ? 'var(--cyan)' : undefined }} />
                </button>

                {/* Fullscreen */}
                <button
                  onClick={toggleFullscreen}
                  className="btn-icon"
                  style={{ width: '36px', height: '36px', borderRadius: '10px' }}
                >
                  {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
                </button>
              </div>

              {/* ── Video Filters Panel ── */}
              {showFilters && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: '100%',
                    right: '0.5rem',
                    marginBottom: '0.75rem',
                    background: 'rgba(14,15,21,0.92)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    border: '1px solid rgba(0,242,254,0.2)',
                    borderRadius: '18px',
                    padding: '1.2rem 1.3rem',
                    width: '280px',
                    boxShadow: '0 8px 40px rgba(0,0,0,0.8), 0 0 20px rgba(0,242,254,0.08)',
                    animation: 'scaleIn 0.2s cubic-bezier(0.16,1,0.3,1)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.85rem',
                    zIndex: 55,
                  }}
                >
                  {/* Panel Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--cyan)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      Фильтры
                    </span>
                    <button
                      onClick={resetFilters}
                      style={{
                        fontSize: '0.68rem',
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
                  </div>

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

                  {/* Aspect Ratio */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                      <Maximize size={13} style={{ color: 'var(--text-muted)' }} />
                      <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Формат</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.35rem' }}>
                      {([
                        { key: 'fit',  label: 'Fit' },
                        { key: '16:9', label: '16:9' },
                        { key: '21:9', label: '21:9 UW' },
                        { key: 'fill', label: 'Fill' },
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
                            fontSize: '0.7rem',
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
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
