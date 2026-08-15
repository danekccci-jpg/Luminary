/**
 * PlayerTouch.tsx — Touch-оптимизированный плеер для Android.
 *
 * Ключевые отличия от Desktop-плеера:
 * - Double-tap left/right → ±10s seek (как YouTube/Netflix)
 * - Swipe up/down left side → volume
 * - Swipe up/down right side → brightness
 * - Tap → show/hide controls (auto-hide 3s)
 * - Touch-optimized seek bar (48px height)
 * - Pinch-to-zoom на видео
 * - Нет scrub preview (неудобно на touch)
 * - Нет PiP (используем Android нативный PiP через Capacitor)
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';

interface PlayerTouchProps {
  streamUrl: string;
  title: string;
  poster?: string;
  startPosition?: number;
  onClose: () => void;
  onProgressSave?: (current: number, duration: number) => void;
}

// ── Touch gesture detection ──
interface GestureState {
  startX: number;
  startY: number;
  startTime: number;
  lastTapTime: number;
  lastTapX: number;
  isDragging: boolean;
}

export const PlayerTouch: React.FC<PlayerTouchProps> = ({
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
  const [showVolumeIndicator, setShowVolumeIndicator] = useState(false);
  const [volumeValue, setVolumeValue] = useState(100);
  const [isBuffering, setIsBuffering] = useState(true);
  const [seekPreview, setSeekPreview] = useState<{ time: number; x: number } | null>(null);

  const gestureRef = useRef<GestureState>({
    startX: 0, startY: 0, startTime: 0,
    lastTapTime: 0, lastTapX: 0, isDragging: false,
  });
  const controlsTimerRef = useRef<NodeJS.Timeout>();
  const volumeTimerRef = useRef<NodeJS.Timeout>();

  // ── Auto-hide controls ──
  const showControlsTemporarily = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 3500);
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
    setVolumeValue(Math.round(clamped * 100));
    setShowVolumeIndicator(true);
    if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
    volumeTimerRef.current = setTimeout(() => setShowVolumeIndicator(false), 1500);
  }, []);

  // ── Touch handlers ──
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    gestureRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: Date.now(),
      lastTapTime: gestureRef.current.lastTapTime,
      lastTapX: gestureRef.current.lastTapX,
      isDragging: false,
    };
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    const g = gestureRef.current;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - g.startX;
    const dy = touch.clientY - g.startY;
    const dt = Date.now() - g.startTime;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Short tap (< 200ms, < 15px movement)
    if (dt < 200 && dist < 15) {
      const now = Date.now();
      const timeSinceLastTap = now - g.lastTapTime;
      const x = touch.clientX;
      const w = containerRef.current?.clientWidth || window.innerWidth;

      // Double-tap detection (< 300ms between taps)
      if (timeSinceLastTap < 300 && Math.abs(x - g.lastTapX) < 100) {
        // Double-tap: left half = -10s, right half = +10s
        if (x < w / 2) {
          seekTo(currentTime - 10);
        } else {
          seekTo(currentTime + 10);
        }
      } else {
        // Single tap: toggle controls
        showControlsTemporarily();
      }

      g.lastTapTime = now;
      g.lastTapX = x;
      return;
    }

    // Swipe detection
    if (dist > 50 && dt < 500) {
      const w = containerRef.current?.clientWidth || window.innerWidth;
      if (Math.abs(dx) > Math.abs(dy)) {
        // Horizontal swipe: seek
        const seekDelta = (dx / w) * duration * 0.5;
        seekTo(currentTime + seekDelta);
      } else {
        // Vertical swipe: volume (left half) or brightness (right half)
        const halfW = w / 2;
        if (g.startX < halfW) {
          // Left side: volume
          const delta = -(dy / (containerRef.current?.clientHeight || window.innerHeight)) * 0.5;
          setVolumeLevel(volume + delta);
        }
        // Right side: brightness (CSS filter) — TODO
      }
    }
  }, [currentTime, duration, volume, seekTo, setVolumeLevel, showControlsTemporarily]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    gestureRef.current.isDragging = true;
    // Could show seek preview here during drag
  }, []);

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
    const onEnded = () => { setIsPlaying(false); showControlsTemporarily(); };

    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('loadedmetadata', onLoadedMetadata);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);

    if (startPosition) v.currentTime = startPosition;
    v.play().then(() => setIsPlaying(true)).catch(() => {});

    return () => {
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('loadedmetadata', onLoadedMetadata);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
    };
  }, [streamUrl, startPosition, showControlsTemporarily]);

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
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
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
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
    >
      {/* Video */}
      <video
        ref={videoRef}
        src={streamUrl}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        playsInline
        preload="auto"
      />

      {/* Volume indicator */}
      {showVolumeIndicator && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'rgba(0,0,0,0.7)',
          borderRadius: '16px',
          padding: '12px 24px',
          color: '#fff',
          fontSize: '18px',
          fontWeight: 700,
          pointerEvents: 'none',
          zIndex: 100,
        }}>
          🔊 {volumeValue}%
        </div>
      )}

      {/* Top bar */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: '16px',
          paddingTop: 'env(safe-area-inset-top, 16px)',
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.8), transparent)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          opacity: showControls ? 1 : 0,
          transition: 'opacity 0.3s',
          zIndex: 50,
        }}
      >
        <button
          onClick={onClose}
          style={{
            background: 'rgba(255,255,255,0.15)',
            border: 'none',
            borderRadius: '50%',
            width: '48px',
            height: '48px',
            color: '#fff',
            fontSize: '24px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ←
        </button>
        <span style={{
          color: '#fff',
          fontSize: '16px',
          fontWeight: 600,
          flex: 1,
          textAlign: 'center',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          margin: '0 12px',
        }}>
          {title}
        </span>
        <div style={{ width: '48px' }} />
      </div>

      {/* Center play/pause (large, touch-friendly) */}
      {!isPlaying && !isBuffering && (
        <button
          onClick={togglePlay}
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '80px',
            height: '80px',
            borderRadius: '50%',
            background: 'rgba(0,0,0,0.6)',
            border: '2px solid rgba(255,255,255,0.3)',
            color: '#fff',
            fontSize: '36px',
            cursor: 'pointer',
            zIndex: 60,
          }}
        >
          ▶
        </button>
      )}

      {/* Bottom controls */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '16px',
          paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
          background: 'linear-gradient(to top, rgba(0,0,0,0.85), transparent)',
          opacity: showControls ? 1 : 0,
          transition: 'opacity 0.3s',
          zIndex: 50,
        }}
      >
        {/* Time */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          color: 'rgba(255,255,255,0.8)',
          fontSize: '13px',
          marginBottom: '8px',
        }}>
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>

        {/* Seek bar — 48px touch target */}
        <div
          style={{
            position: 'relative',
            height: '48px',
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
          }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const pct = x / rect.width;
            seekTo(pct * duration);
          }}
        >
          {/* Track background */}
          <div style={{
            position: 'absolute',
            left: 0,
            right: 0,
            height: '4px',
            background: 'rgba(255,255,255,0.2)',
            borderRadius: '2px',
          }} />
          {/* Buffered */}
          <div style={{
            position: 'absolute',
            left: 0,
            height: '4px',
            width: `${bufferedPercent}%`,
            background: 'rgba(255,255,255,0.3)',
            borderRadius: '2px',
          }} />
          {/* Played */}
          <div style={{
            position: 'absolute',
            left: 0,
            height: '4px',
            width: `${progressPercent}%`,
            background: '#00F2FE',
            borderRadius: '2px',
          }} />
          {/* Thumb */}
          <div style={{
            position: 'absolute',
            left: `${progressPercent}%`,
            transform: 'translateX(-50%)',
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            background: '#00F2FE',
            boxShadow: '0 0 10px rgba(0,242,254,0.6)',
          }} />
        </div>

        {/* Bottom buttons */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-around',
          alignItems: 'center',
          marginTop: '8px',
        }}>
          <button
            onClick={() => seekTo(currentTime - 10)}
            style={btnStyle}
          >
            -10s
          </button>
          <button
            onClick={togglePlay}
            style={{ ...btnStyle, width: '64px', height: '64px', fontSize: '28px' }}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button
            onClick={() => seekTo(currentTime + 10)}
            style={btnStyle}
          >
            +10s
          </button>
          <button
            onClick={() => setVolumeLevel(volume > 0 ? 0 : 1)}
            style={btnStyle}
          >
            {volume === 0 ? '🔇' : '🔊'}
          </button>
        </div>
      </div>

      {/* Buffering spinner */}
      {isBuffering && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          color: '#00F2FE',
          fontSize: '48px',
          zIndex: 100,
        }}>
          ⟳
        </div>
      )}
    </div>
  );
};

const btnStyle: React.CSSProperties = {
  width: '52px',
  height: '52px',
  borderRadius: '50%',
  background: 'rgba(255,255,255,0.1)',
  border: '1px solid rgba(255,255,255,0.2)',
  color: '#fff',
  fontSize: '14px',
  fontWeight: 700,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export default PlayerTouch;
