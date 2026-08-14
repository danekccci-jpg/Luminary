/**
 * PlayerTV.tsx — Плеер для Android TV (управление пультом).
 *
 * Отличия от Desktop и Touch:
 * - OK (Enter) = play/pause
 * - Left/Right = seek ±10s
 * - Up/Down = volume
 * - Back = close player
 * - Крупные элементы (10-foot viewing)
 * - Нет hover, нет touch — только фокус и D-pad
 * - Контролы показываются по любому нажатию
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';

interface PlayerTVProps {
  streamUrl: string;
  title: string;
  poster?: string;
  startPosition?: number;
  onClose: () => void;
  onProgressSave?: (current: number, duration: number) => void;
}

export const PlayerTV: React.FC<PlayerTVProps> = ({
  streamUrl,
  title,
  poster,
  startPosition,
  onClose,
  onProgressSave,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const [showVolumeHud, setShowVolumeHud] = useState(false);
  const [volumeHudValue, setVolumeHudValue] = useState(100);
  const [isBuffering, setIsBuffering] = useState(true);

  const controlsTimerRef = useRef<NodeJS.Timeout>();
  const volumeTimerRef = useRef<NodeJS.Timeout>();

  // ── Auto-hide controls ──
  const showControlsTemporarily = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 4000);
  }, [isPlaying]);

  // ── Play/Pause ──
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setIsPlaying(true); }
    else { v.pause(); setIsPlaying(false); }
  }, []);

  // ── Seek ──
  const seekTo = useCallback((time: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration, time));
  }, [duration]);

  // ── Volume ──
  const setVolumeLevel = useCallback((val: number) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.max(0, Math.min(1, val));
    v.volume = clamped;
    setVolume(clamped);
    setVolumeHudValue(Math.round(clamped * 100));
    setShowVolumeHud(true);
    if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
    volumeTimerRef.current = setTimeout(() => setShowVolumeHud(false), 2000);
  }, []);

  // ── Keyboard/D-pad handler ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      showControlsTemporarily();

      switch (e.key) {
        case 'Enter':
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seekTo(currentTime - 10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          seekTo(currentTime + 10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setVolumeLevel(volume + 0.05);
          break;
        case 'ArrowDown':
          e.preventDefault();
          setVolumeLevel(volume - 0.05);
          break;
        case 'Escape':
        case 'Backspace':
          e.preventDefault();
          if (onProgressSave && videoRef.current && duration > 0) {
            onProgressSave(videoRef.current.currentTime, videoRef.current.duration);
          }
          onClose();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          if (document.fullscreenElement) document.exitFullscreen();
          else containerRef.current?.requestFullscreen();
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentTime, duration, volume, isPlaying, togglePlay, seekTo, setVolumeLevel, showControlsTemporarily, onClose, onProgressSave]);

  // ── Video events ──
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const onTimeUpdate = () => {
      setCurrentTime(v.currentTime);
      if (v.buffered.length > 0) setBuffered(v.buffered.end(v.buffered.length - 1));
    };
    const onLoadedMetadata = () => { setDuration(v.duration); setIsBuffering(false); };
    const onWaiting = () => setIsBuffering(true);
    const onPlaying = () => { setIsBuffering(false); setIsPlaying(true); };
    const onPause = () => setIsPlaying(false);

    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('loadedmetadata', onLoadedMetadata);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('pause', onPause);

    if (startPosition) v.currentTime = startPosition;
    v.play().then(() => setIsPlaying(true)).catch(() => {});

    return () => {
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('loadedmetadata', onLoadedMetadata);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('pause', onPause);
    };
  }, [streamUrl, startPosition]);

  // Save progress on unmount
  useEffect(() => {
    return () => {
      const v = videoRef.current;
      if (onProgressSave && v && duration > 0) {
        onProgressSave(v.currentTime, v.duration);
      }
    };
  }, [onProgressSave, duration]);

  const formatTime = (sec: number) => {
    if (isNaN(sec)) return '0:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
        cursor: 'none',
        userSelect: 'none',
      }}
      onClick={togglePlay}
    >
      {/* Video */}
      <video
        ref={videoRef}
        src={streamUrl}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        playsInline
        preload="auto"
      />

      {/* Volume HUD */}
      {showVolumeHud && (
        <div style={{
          position: 'absolute',
          right: '80px',
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'rgba(0,0,0,0.8)',
          borderRadius: '16px',
          padding: '20px 32px',
          color: '#fff',
          fontSize: '24px',
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          gap: '16px',
          pointerEvents: 'none',
          zIndex: 100,
        }}>
          <span style={{ fontSize: '32px' }}>{volume === 0 ? '🔇' : '🔊'}</span>
          <span>{volumeHudValue}%</span>
        </div>
      )}

      {/* Top bar */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        padding: '40px 60px 80px',
        background: 'linear-gradient(to bottom, rgba(0,0,0,0.85), transparent)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        opacity: showControls ? 1 : 0,
        transition: 'opacity 0.4s ease',
        zIndex: 50,
      }}>
        <div>
          <div style={{ color: '#fff', fontSize: '28px', fontWeight: 800, marginBottom: '8px' }}>
            {title}
          </div>
          <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: '18px' }}>
            {isPlaying ? '▶ Воспроизведение' : '⏸ Пауза'}
          </div>
        </div>
      </div>

      {/* Bottom controls */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        padding: '80px 60px 40px',
        background: 'linear-gradient(to top, rgba(0,0,0,0.85), transparent)',
        opacity: showControls ? 1 : 0,
        transition: 'opacity 0.4s ease',
        zIndex: 50,
      }}>
        {/* Seek bar — крупная, удобная для пульта */}
        <div
          style={{
            position: 'relative',
            height: '12px',
            background: 'rgba(255,255,255,0.15)',
            borderRadius: '6px',
            marginBottom: '24px',
            cursor: 'pointer',
          }}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            seekTo(pct * duration);
          }}
        >
          <div style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${bufferedPercent}%`,
            background: 'rgba(255,255,255,0.25)',
            borderRadius: '6px',
          }} />
          <div style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${progressPercent}%`,
            background: '#00F2FE',
            borderRadius: '6px',
          }} />
          <div style={{
            position: 'absolute',
            left: `${progressPercent}%`,
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: '24px',
            height: '24px',
            borderRadius: '50%',
            background: '#00F2FE',
            boxShadow: '0 0 20px rgba(0,242,254,0.7)',
          }} />
        </div>

        {/* Time + controls row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'rgba(255,255,255,0.8)', fontSize: '20px', fontWeight: 600 }}>
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          <div style={{ display: 'flex', gap: '24px', alignItems: 'center' }}>
            <button
              onClick={(e) => { e.stopPropagation(); seekTo(currentTime - 10); }}
              style={tvBtnStyle}
            >
              ← 10с
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); togglePlay(); }}
              style={{ ...tvBtnStyle, width: '80px', height: '80px', fontSize: '32px' }}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); seekTo(currentTime + 10); }}
              style={tvBtnStyle}
            >
              10с →
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setVolumeLevel(volume > 0 ? 0 : 1); }}
              style={tvBtnStyle}
            >
              {volume === 0 ? '🔇' : '🔊'}
            </button>
          </div>
        </div>
      </div>

      {/* Buffering */}
      {isBuffering && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          color: '#00F2FE',
          fontSize: '64px',
          zIndex: 100,
        }}>
          ⟳
        </div>
      )}
    </div>
  );
};

const tvBtnStyle: React.CSSProperties = {
  width: '64px',
  height: '64px',
  borderRadius: '16px',
  background: 'rgba(255,255,255,0.1)',
  border: '2px solid rgba(255,255,255,0.2)',
  color: '#fff',
  fontSize: '18px',
  fontWeight: 700,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'all 0.2s',
};

export default PlayerTV;
