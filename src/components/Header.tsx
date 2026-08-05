import React, { useState, useCallback, useRef } from 'react';
import {
  Film,
  Search,
  Settings as SettingsIcon,
  Link,
  Server,
  X,
  Zap,
} from 'lucide-react';
import { TorrServerStatusInfo } from '../types';

interface HeaderProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onOpenSettings: () => void;
  onOpenMagnetModal: () => void;
  torrServerStatus: TorrServerStatusInfo;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  searchQuery,
  setSearchQuery,
  onOpenSettings,
  onOpenMagnetModal,
  torrServerStatus,
}) => {
  const [searchFocused, setSearchFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const tabs = [
    { id: 'home',   label: 'Главная' },
    { id: 'movies', label: 'Фильмы' },
    { id: 'top',    label: 'Топ' },
  ];

  return (
    <header
      className="sticky top-0 z-40 w-full"
      style={{
        background: 'rgba(10, 11, 14, 0.85)',
        backdropFilter: 'blur(24px) saturate(180%)',
        WebkitBackdropFilter: 'blur(24px) saturate(180%)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <div
        style={{
          maxWidth: '1400px',
          margin: '0 auto',
          padding: '0 1.5rem',
          height: '64px',
          display: 'flex',
          alignItems: 'center',
          gap: '1.5rem',
        }}
      >
        {/* ── Logo ── */}
        <div
          onClick={() => setActiveTab('home')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.65rem',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, #00c6fb 0%, #8A2BE2 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 20px rgba(0, 198, 251, 0.3)',
              flexShrink: 0,
            }}
          >
            <Film size={18} color="#fff" />
          </div>
          <div>
            <div
              style={{
                fontSize: '1.05rem',
                fontWeight: 900,
                letterSpacing: '0.12em',
                background: 'linear-gradient(135deg, #fff 40%, rgba(0,242,254,0.8))',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                lineHeight: 1,
              }}
            >
              LUMINARY
            </div>
            <div
              style={{
                fontSize: '0.6rem',
                letterSpacing: '0.15em',
                color: 'rgba(0,242,254,0.5)',
                fontWeight: 700,
                textTransform: 'uppercase',
                marginTop: '1px',
              }}
            >
              TORRENT CINEMA
            </div>
          </div>
        </div>

        {/* ── Nav Tabs ── */}
        <nav
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '2px',
            background: 'rgba(255,255,255,0.04)',
            padding: '4px',
            borderRadius: '14px',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '0.38rem 0.9rem',
                borderRadius: '10px',
                fontSize: '0.82rem',
                fontWeight: 700,
                fontFamily: 'inherit',
                border: 'none',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                background:
                  activeTab === tab.id
                    ? 'linear-gradient(135deg, rgba(0,198,251,0.2), rgba(138,43,226,0.15))'
                    : 'transparent',
                color:
                  activeTab === tab.id
                    ? '#00F2FE'
                    : 'rgba(240,242,248,0.5)',
                boxShadow:
                  activeTab === tab.id
                    ? '0 0 12px rgba(0,242,254,0.2), inset 0 0 0 1px rgba(0,242,254,0.2)'
                    : 'none',
              }}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* ── Search Bar ── */}
        <div style={{ flex: 1, position: 'relative', maxWidth: '320px', marginLeft: 'auto' }}>
          <Search
            size={15}
            style={{
              position: 'absolute',
              left: '12px',
              top: '50%',
              transform: 'translateY(-50%)',
              color: searchFocused ? 'var(--cyan)' : 'rgba(240,242,248,0.35)',
              transition: 'color 0.2s',
              pointerEvents: 'none',
            }}
          />
          <input
            ref={inputRef}
            type="text"
            placeholder="Поиск фильмов..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            className="input-glass"
            style={{
              paddingLeft: '36px',
              paddingRight: searchQuery ? '36px' : '12px',
              borderRadius: '12px',
              height: '38px',
              fontSize: '0.84rem',
            }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              style={{
                position: 'absolute',
                right: '10px',
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'rgba(255,255,255,0.1)',
                border: 'none',
                borderRadius: '50%',
                width: '20px',
                height: '20px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'rgba(240,242,248,0.6)',
              }}
            >
              <X size={10} />
            </button>
          )}
        </div>

        {/* ── Right Actions ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
          {/* Magnet Button */}
          <button
            onClick={onOpenMagnetModal}
            className="btn-icon"
            title="Открыть Magnet-ссылку"
            style={{ padding: '0.5rem 0.8rem', borderRadius: '12px', gap: '0.4rem', display: 'flex', alignItems: 'center', fontSize: '0.8rem', fontWeight: 600 }}
          >
            <Link size={15} style={{ color: 'var(--cyan)' }} />
            <span style={{ color: 'var(--text-secondary)' }}>Magnet</span>
          </button>

          {/* TorrServer Status Indicator */}
          <button
            onClick={onOpenSettings}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.45rem 0.9rem',
              borderRadius: '12px',
              border: `1px solid ${torrServerStatus.running ? 'rgba(16,245,172,0.35)' : 'rgba(255,84,112,0.35)'}`,
              background: torrServerStatus.running ? 'rgba(16,245,172,0.07)' : 'rgba(255,84,112,0.07)',
              cursor: 'pointer',
              fontSize: '0.78rem',
              fontWeight: 700,
              fontFamily: 'inherit',
              color: torrServerStatus.running ? 'var(--emerald)' : 'var(--coral)',
              transition: 'all 0.2s ease',
            }}
          >
            <span
              style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: torrServerStatus.running ? 'var(--emerald)' : 'var(--coral)',
                boxShadow: torrServerStatus.running
                  ? '0 0 8px rgba(16,245,172,0.7)'
                  : '0 0 8px rgba(255,84,112,0.7)',
                animation: torrServerStatus.running ? 'pulseNeon 2s ease-in-out infinite' : 'none',
                flexShrink: 0,
              }}
            />
            <Server size={13} />
            <span style={{ display: 'none' }}>
              {torrServerStatus.running ? 'Online' : 'Offline'}
            </span>
          </button>

          {/* Settings */}
          <button
            onClick={onOpenSettings}
            className="btn-icon"
            title="Настройки"
          >
            <SettingsIcon size={16} />
          </button>
        </div>
      </div>
    </header>
  );
};
