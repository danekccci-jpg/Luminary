/**
 * HeaderBottom.tsx — Нижняя навигация для Android (bottom nav bar).
 * Вместо верхних таблов используется нижний бар — стандарт для мобильных приложений.
 */
import React from 'react';

interface HeaderBottomProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

const tabs = [
  { id: 'home',      label: 'Главная',  icon: '🏠' },
  { id: 'movies',    label: 'Фильмы',   icon: '🎬' },
  { id: 'search',    label: 'Поиск',    icon: '🔍' },
  { id: 'library',   label: 'Библиотека', icon: '📚' },
];

export const HeaderBottom: React.FC<HeaderBottomProps> = ({ activeTab, setActiveTab }) => {
  const currentTab = activeTab === 'top' || activeTab === 'favorites' || activeTab === 'later' || activeTab === 'history'
    ? 'library'
    : activeTab;

  return (
    <nav style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      height: '64px',
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      background: 'rgba(10, 11, 14, 0.95)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      borderTop: '1px solid rgba(255,255,255,0.08)',
      display: 'flex',
      justifyContent: 'space-around',
      alignItems: 'center',
      zIndex: 40,
    }}>
      {tabs.map((tab) => {
        const isActive = currentTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '2px',
              background: 'none',
              border: 'none',
              padding: '8px 16px',
              cursor: 'pointer',
              minWidth: '64px',
              minHeight: '48px',
            }}
          >
            <span style={{ fontSize: '22px' }}>{tab.icon}</span>
            <span style={{
              fontSize: '11px',
              fontWeight: isActive ? 700 : 500,
              color: isActive ? '#00F2FE' : 'rgba(240,242,248,0.5)',
              transition: 'color 0.2s',
            }}>
              {tab.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
};

export default HeaderBottom;
