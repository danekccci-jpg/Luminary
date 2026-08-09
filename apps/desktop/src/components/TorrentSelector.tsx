import React, { useState } from 'react';
import {
  Download, Search,
  Volume2, Loader2,
} from 'lucide-react';
import { TorrentRelease } from '../types';
import { parseTorrentMeta, russianPriority } from '../utils/torrentMeta';
import { TorrentCard } from './TorrentCard';

interface TorrentSelectorProps {
  releases: TorrentRelease[];
  isLoading: boolean;
  onPlayRelease: (release: TorrentRelease) => void;
  /** Повторный поиск раздач (после пустого результата/ошибки). */
  onRetry?: () => void;
  /** Текст ошибки поиска (если сервис вернул error). */
  error?: string | null;
  /** Фоновый поиск RuTracker ещё идёт — раздачи приедут позже. */
  isRutrackerSearching?: boolean;
  /** Сколько сезонов в сериале (0 = не сериал / неизвестно). */
  tvSeasons?: number;
  /** Выбранный сезон (0 = все). Управляется родителем (нужен для перепоиска). */
  seasonFilter?: number;
  onSeasonFilterChange?: (season: number) => void;
}

export const TorrentSelector: React.FC<TorrentSelectorProps> = React.memo(({
  releases,
  isLoading,
  onPlayRelease,
  onRetry,
  error,
  isRutrackerSearching,
  tvSeasons = 0,
  seasonFilter = 0,
  onSeasonFilterChange,
}) => {
  const [qualityFilter, setQualityFilter]   = useState('ALL');
  const [dubbingFilter, setDubbingFilter]   = useState('ALL');
  const [sortBy, setSortBy]                 = useState<'russian' | 'seeders' | 'size' | 'stability'>('russian');
  const [keyword, setKeyword]               = useState('');

  const dubbingOptions = ['ALL', 'Дубляж', 'HDRezka', 'LostFilm', 'Оригинал + Субтитры', 'RHS'];
  const qualityOptions = ['ALL', '4K', '1080p', '720p'];

  /** Сезоны раздачи: {from, to} из названия (S01, S01-S03, «сезон 2»), null — без маркера. */
  const seasonsOf = (title: string): { from: number; to: number } | null => {
    const range = String(title).match(/s(\d{1,2})\s*[-–—]\s*(\d{1,2})/i);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      return { from: Math.min(a, b), to: Math.max(a, b) };
    }
    const meta = parseTorrentMeta(title);
    if (meta.seasons != null) return { from: meta.seasons, to: meta.seasons };
    return null;
  };

  /** Подходит ли раздача выбранному сезону (без маркера — показываем: может быть весь сериал). */
  const matchesSeason = (title: string): boolean => {
    if (seasonFilter <= 0) return true;
    const s = seasonsOf(title);
    if (!s) return true;
    return seasonFilter >= s.from && seasonFilter <= s.to;
  };

  const filtered = releases.filter((r) => {
    if (qualityFilter !== 'ALL' && r.quality !== qualityFilter) return false;
    if (dubbingFilter !== 'ALL' && r.dubbing !== dubbingFilter) return false;
    if (seasonFilter > 0 && !matchesSeason(r.title)) return false;
    if (keyword.trim()) {
      const kw = keyword.toLowerCase();
      if (!r.title.toLowerCase().includes(kw) && !r.tags.some(t => t.toLowerCase().includes(kw))) return false;
    }
    return true;
  });

  // RU-first: приоритет русской озвучки и флагманских студий (Lampa-style),
  // внутри группы — по количеству сидов.
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'russian') {
      const pa = russianPriority(a);
      const pb = russianPriority(b);
      if (pb !== pa) return pb - pa;
      return b.seeders - a.seeders;
    }
    if (sortBy === 'seeders')   return b.seeders - a.seeders;
    if (sortBy === 'size')      return b.sizeBytes - a.sizeBytes;
    if (sortBy === 'stability') return b.stabilityScore - a.stabilityScore;
    return 0;
  });

  return (
    <div className="torrent-panel">
      {/* ── Header ── */}
      <div className="torrent-panel-header">
        <div className="torrent-panel-heading">
          <div className="torrent-panel-icon">
            <Download size={15} />
          </div>
          <div>
            <div className="torrent-panel-title">
              <span>Доступные раздачи</span>
              <span className="torrent-panel-count">{filtered.length}</span>
            </div>
            <div className="torrent-panel-sub">
              Мульти-парсер: JacRed · Torrentio · Rutor · Jackett
            </div>
          </div>
        </div>

        {/* Keyword Search */}
        <div className="torrent-search">
          <Search size={13} className="torrent-search-icon" />
          <input
            type="text"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="RHS, REMUX, DV..."
            className="torrent-search-input"
          />
        </div>
      </div>

      {/* ── Filter Chips Panel ── */}
      <div className="torrent-filters">
        {/* Quality */}
        <div className="torrent-filter-row">
          <span className="torrent-filter-label">Качество</span>
          <div className="torrent-filter-chips">
            {qualityOptions.map(q => {
              const isActive = qualityFilter === q;
              const tierActive = q === '4K' && isActive;
              return (
                <button
                  key={q}
                  onClick={() => setQualityFilter(q)}
                  className={`filter-chip${isActive ? ' active' : ''}${tierActive ? ' active-amber' : ''}`}
                >
                  {q === 'ALL' ? 'Все' : q}
                </button>
              );
            })}
          </div>
        </div>

        {/* Dubbing */}
        <div className="torrent-filter-row">
          <span className="torrent-filter-label">
            <Volume2 size={11} aria-hidden="true" />
            Озвучка
          </span>
          <div className="torrent-filter-chips">
            {dubbingOptions.map(d => {
              const isActive = dubbingFilter === d;
              return (
                <button
                  key={d}
                  onClick={() => setDubbingFilter(d)}
                  className={`filter-chip${isActive ? ' active' : ''}`}
                >
                  {d === 'ALL' ? 'Все студии' : d}
                </button>
              );
            })}
          </div>
        </div>

        {/* Sort Selector (RU-first по умолчанию) */}
        <div className="torrent-filter-row">
          <span className="torrent-filter-label">Сортировка</span>
          <div className="torrent-filter-chips">
            {[
              { id: 'russian',   label: 'RU + Сиды' },
              { id: 'seeders',   label: 'По сидам' },
              { id: 'stability', label: 'Smart Choice' },
              { id: 'size',      label: 'Размер' },
            ].map(opt => (
              <button
                key={opt.id}
                onClick={() => setSortBy(opt.id as any)}
                className={`filter-chip${sortBy === opt.id ? ' active' : ''}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Сезоны (для сериалов): фильтрует раздачи по S01/S02… ── */}
      {tvSeasons > 1 && onSeasonFilterChange && (
        <div className="torrent-season-row">
          <span className="torrent-filter-label">Сезон</span>
          <div className="torrent-filter-chips">
            {[0, ...Array.from({ length: tvSeasons }, (_, i) => i + 1)].map((s) => (
              <button
                key={s}
                onClick={() => onSeasonFilterChange(s)}
                className={`filter-chip${seasonFilter === s ? ' active' : ''}`}
              >
                {s === 0 ? 'Все' : `S${String(s).padStart(2, '0')}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── RuTracker ищет раздачи (фоновый поиск, догонят список) ── */}
      {isRutrackerSearching && releases.length > 0 && (
        <div className="torrent-note">
          <Loader2 size={13} className="animate-spin" />
          RuTracker: ищем раздачи…
        </div>
      )}

      {/* ── Release List ── */}
      <div className="torrent-list">
        {isLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[1, 2, 3].map(n => (
              <div key={n} className="torrent-card-skeleton" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="torrent-empty">
            <div className="torrent-empty-icon">
              <Download size={20} />
            </div>
            <p className="torrent-empty-title">
              {isRutrackerSearching ? (
                <>
                  <Loader2 size={14} className="animate-spin" style={{ verticalAlign: '-2px', marginRight: '6px' }} />
                  RuTracker: ищем раздачи…
                </>
              ) : (
                'Раздачи не найдены или парсеры недоступны'
              )}
            </p>
            {!isRutrackerSearching && (
              <p className="torrent-empty-sub">
                {error || 'Попробуйте повторить поиск — часть источников могла временно отвалиться'}
              </p>
            )}
            {onRetry && !isRutrackerSearching && (
              <button
                onClick={onRetry}
                className="btn-accent"
              >
                <Search size={14} />
                Повторить поиск
              </button>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {sorted.map((release, idx) => (
              <TorrentCard
                key={release.id}
                release={release}
                index={idx}
                onPlay={() => onPlayRelease(release)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
