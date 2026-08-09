import React, { useRef, useEffect, useState } from 'react';
import { X, Play } from 'lucide-react';
import { useFocusTrap } from '../utils/focus';
import { registerBackHandler } from '../utils/tv';

interface MagnetInputModalProps {
  onClose: () => void;
  onPlayMagnet: (magnet: string, customTitle: string) => void;
}

export const MagnetInputModal: React.FC<MagnetInputModalProps> = ({
  onClose,
  onPlayMagnet,
}) => {
  const [magnet, setMagnet] = useState('');
  const [title,  setTitle]  = useState('');

  // ── TV/клавиатура: focus trap + Back (пульт/Escape) закрывает ──
  const modalRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(true, modalRef);
  useEffect(() => registerBackHandler(() => { onClose(); return true; }), [onClose]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!magnet.trim()) return;
    onPlayMagnet(magnet.trim(), title.trim() || 'Потоковое видео');
  };

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
      }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '460px',
          background: 'rgba(11,12,17,0.99)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '24px',
          padding: '1.8rem',
          boxShadow: '0 24px 60px rgba(0,0,0,0.9), 0 0 0 1px rgba(0,242,254,0.06)',
          animation: 'scaleIn 0.3s cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: '1rem',
            right: '1rem',
            width: '34px',
            height: '34px',
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.08)',
            color: 'rgba(240,242,248,0.5)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,84,112,0.2)';
            (e.currentTarget as HTMLButtonElement).style.color = '#FF5470';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)';
            (e.currentTarget as HTMLButtonElement).style.color = 'rgba(240,242,248,0.5)';
          }}
        >
          <X size={14} />
        </button>

        {/* Header */}
        <div style={{ marginBottom: '1.6rem' }}>
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, rgba(0,198,251,0.15), rgba(138,43,226,0.15))',
              border: '1px solid rgba(0,242,254,0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '0.9rem',
              boxShadow: '0 0 16px rgba(0,242,254,0.1)',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(0,242,254,0.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '0.2rem' }}>Открыть Magnet-ссылку</h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Прямой запуск торрента через TorrServer MatriX</p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          {/* Magnet Input */}
          <div>
            <label style={{ fontSize: '0.72rem', fontWeight: 700, color: 'rgba(0,242,254,0.6)', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: '0.4rem' }}>
              Magnet URL *
            </label>
            <textarea
              required
              rows={3}
              value={magnet}
              onChange={e => setMagnet(e.target.value)}
              placeholder="magnet:?xt=urn:btih:..."
              className="input-glass"
              style={{ resize: 'none', fontFamily: 'monospace', fontSize: '0.78rem', lineHeight: 1.5, padding: '0.7rem 0.9rem' }}
            />
          </div>

          {/* Custom Title */}
          <div>
            <label style={{ fontSize: '0.72rem', fontWeight: 700, color: 'rgba(240,242,248,0.4)', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: '0.4rem' }}>
              Название потока (опционально)
            </label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Например: Аватар 2 (2022)"
              className="input-glass"
              style={{ height: '40px' }}
            />
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '0.6rem', paddingTop: '0.5rem' }}>
            <button type="button" onClick={onClose} className="btn-secondary" style={{ flex: 1, justifyContent: 'center' }}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" style={{ flex: 1.5, justifyContent: 'center', borderRadius: '12px' }}>
              <Play size={14} fill="white" />
              <span>Воспроизвести</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
