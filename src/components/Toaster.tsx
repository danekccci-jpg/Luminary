import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { toastBus, Toast } from '../services/toast';

const ICONS: Record<Toast['type'], React.ReactNode> = {
  info: <Info size={16} color="#00F2FE" />,
  success: <CheckCircle2 size={16} color="#10F5AC" />,
  error: <AlertTriangle size={16} color="#FF5470" />,
};

const COLORS: Record<Toast['type'], string> = {
  info: 'rgba(0,242,254,0.12)',
  success: 'rgba(16,245,172,0.12)',
  error: 'rgba(255,84,112,0.14)',
};

const BORDERS: Record<Toast['type'], string> = {
  info: 'rgba(0,242,254,0.35)',
  success: 'rgba(16,245,172,0.35)',
  error: 'rgba(255,84,112,0.4)',
};

export const Toaster: React.FC = () => {
  const [items, setItems] = useState<Toast[]>([]);

  useEffect(() => toastBus.subscribe(setItems), []);

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '1.5rem',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.5rem',
        pointerEvents: 'none',
        maxWidth: '92vw',
      }}
    >
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
            padding: '0.7rem 1rem 0.7rem 0.85rem',
            borderRadius: '14px',
            background: COLORS[t.type],
            border: `1px solid ${BORDERS[t.type]}`,
            WebkitBackdropFilter: 'blur(14px)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
            fontSize: '0.82rem',
            fontWeight: 600,
            color: 'var(--text-primary)',
            pointerEvents: 'auto',
            animation: 'toastIn 0.28s cubic-bezier(0.16,1,0.3,1)',
            maxWidth: '420px',
          }}
        >
          <span style={{ flexShrink: 0, display: 'flex' }}>{ICONS[t.type]}</span>
          <span style={{ lineHeight: 1.4 }}>{t.message}</span>
          <button
            onClick={() => toastBus.dismiss(t.id)}
            aria-label="Закрыть"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'rgba(240,242,248,0.5)',
              display: 'flex',
              padding: '2px',
              flexShrink: 0,
            }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
};
