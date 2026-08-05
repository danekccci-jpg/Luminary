import React, { useState, useMemo } from 'react';
import {
  Play, Download, Users, HardDrive, Search,
  AlertTriangle, Zap, Volume2,
} from 'lucide-react';
import { TorrentRelease, DubbingType } from '../types';
import { parseTorrentMeta, russianPriority } from '../utils/torrentMeta';

interface TorrentSelectorProps {
  releases: TorrentRelease[];
  isLoading: boolean;
  onPlayRelease: (release: TorrentRelease) => void;
}

// ── Circular Health Indicator SVG ──────────────
const HealthRing: React.FC<{ score: number; label: string }> = ({ score, label }) => {
  const r = 20;
  const circ = 2 * Math.PI * r;
  const dashOffset = circ - (circ * score) / 100;

  const color =
    score >= 80 ? '#10F5AC'
    : score >= 55 ? '#00F2FE'
    : score >= 35 ? '#FFB800'
    : '#FF5470';

  return (
    <div
      title={`Индекс стабильности: ${score}%`}
      style={{
        position: 'relative',
        width: '54px',
        height: '54px',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width="54" height="54" style={{ transform: 'rotate(-90deg)', position: 'absolute' }}>
        {/* Track */}
        <circle
          cx="27" cy="27" r={r}
          fill="none"
          stroke="rgba(255,255,255,0.07)"
          strokeWidth="3"
        />
        {/* Progress Arc */}
        <circle
          cx="27" cy="27" r={r}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeDasharray={circ}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          style={{
            filter: `drop-shadow(0 0 4px ${color})`,
            transition: 'stroke-dashoffset 0.8s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
          }}
        />
      </svg>
      {/* Score Text */}
      <div
        style={{
          position: 'relative',
          textAlign: 'center',
          lineHeight: 1,
        }}
      >
        <div style={{ fontSize: '0.72rem', fontWeight: 900, color }}>{score}</div>
        <div style={{ fontSize: '0.52rem', color: 'rgba(240,242,248,0.35)', fontWeight: 700, marginTop: '1px' }}>HealthID</div>
      </div>
    </div>
  );
};

// ── Dubbing Chip Styling ───────────────────────
const getDubbingStyle = (dub: string) => {
  switch (dub) {
    case 'Дубляж':        return { bg: 'rgba(16,245,172,0.1)',  color: '#10F5AC', border: 'rgba(16,245,172,0.35)',  glow: 'rgba(16,245,172,0.2)' };
    case 'RHS':           return { bg: 'rgba(16,245,172,0.1)',  color: '#10F5AC', border: 'rgba(16,245,172,0.35)',  glow: 'rgba(16,245,172,0.2)' };
    case 'HDRezka':       return { bg: 'rgba(138,43,226,0.12)', color: '#B57BFF', border: 'rgba(138,43,226,0.4)',   glow: 'rgba(138,43,226,0.25)' };
    case 'LostFilm':      return { bg: 'rgba(138,43,226,0.1)',  color: '#c084fc', border: 'rgba(192,132,252,0.35)', glow: 'rgba(192,132,252,0.2)' };
    case 'TVShows':       return { bg: 'rgba(138,43,226,0.1)',  color: '#c084fc', border: 'rgba(192,132,252,0.35)', glow: 'rgba(192,132,252,0.2)' };
    case 'Кубик в Кубе':  return { bg: 'rgba(217,70,239,0.1)',  color: '#D946EF', border: 'rgba(217,70,239,0.35)',  glow: 'rgba(217,70,239,0.2)' };
    default:              return { bg: 'rgba(0,242,254,0.08)',   color: '#00F2FE', border: 'rgba(0,242,254,0.3)',    glow: 'rgba(0,242,254,0.15)' };
  }
};

// ── Quality Badge Styles ───────────────────────
const getQualityStyle = (q: string) => {
  switch (q) {
    case '4K':    return { bg: 'rgba(255,184,0,0.14)',   color: '#FFB800', border: 'rgba(255,184,0,0.45)',   glow: 'rgba(255,184,0,0.25)' };
    case '1080p': return { bg: 'rgba(0,242,254,0.1)',    color: '#00F2FE', border: 'rgba(0,242,254,0.35)',   glow: 'rgba(0,242,254,0.2)' };
    case '720p':  return { bg: 'rgba(16,245,172,0.1)',   color: '#10F5AC', border: 'rgba(16,245,172,0.3)',   glow: '' };
    default:      return { bg: 'rgba(255,255,255,0.06)', color: 'rgba(240,242,248,0.5)', border: 'rgba(255,255,255,0.1)', glow: '' };
  }
};

export const TorrentSelector: React.FC<TorrentSelectorProps> = React.memo(({
  releases,
  isLoading,
  onPlayRelease,
}) => {
  const [qualityFilter, setQualityFilter]   = useState('ALL');
  const [dubbingFilter, setDubbingFilter]   = useState('ALL');
  const [sortBy, setSortBy]                 = useState<'russian' | 'seeders' | 'size' | 'stability'>('russian');
  const [keyword, setKeyword]               = useState('');

  const dubbingOptions = ['ALL', 'Дубляж', 'HDRezka', 'LostFilm', 'Оригинал + Субтитры', 'RHS'];
  const qualityOptions = ['ALL', '4K', '1080p', '720p'];

  const filtered = releases.filter((r) => {
    if (qualityFilter !== 'ALL' && r.quality !== qualityFilter) return false;
    if (dubbingFilter !== 'ALL' && r.dubbing !== dubbingFilter) return false;
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

  // Кэш разбора метаданных (озвучки/серии/аудио) — избегаем повторного
  // parseTorrentMeta на каждый рендер карточки (до 13 вызовов на раздачу).
  const metaCache = useMemo(() => {
    const m = new Map<string, ReturnType<typeof parseTorrentMeta>>();
    for (const r of releases) m.set(r.id, parseTorrentMeta(r.title));
    return m;
  }, [releases]);
  const metaOf = (r: TorrentRelease) => metaCache.get(r.id) || parseTorrentMeta(r.title);

  return (
    <div
      style={{
        marginTop: '2rem',
        background: 'rgba(14,15,21,0.93)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: '22px',
        overflow: 'hidden',
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          padding: '1.2rem 1.4rem 1rem',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          background: 'linear-gradient(135deg, rgba(0,242,254,0.04), rgba(138,43,226,0.03))',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
          <div
            style={{
              width: '34px',
              height: '34px',
              borderRadius: '10px',
              background: 'linear-gradient(135deg, rgba(0,198,251,0.2), rgba(138,43,226,0.2))',
              border: '1px solid rgba(0,242,254,0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 12px rgba(0,242,254,0.15)',
            }}
          >
            <Download size={16} style={{ color: 'var(--cyan)' }} />
          </div>
          <div>
            <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span>Доступные раздачи</span>
              <span style={{
                padding: '1px 8px',
                borderRadius: '999px',
                background: 'rgba(0,242,254,0.12)',
                border: '1px solid rgba(0,242,254,0.3)',
                color: 'var(--cyan)',
                fontSize: '0.72rem',
                fontWeight: 900,
              }}>
                {filtered.length}
              </span>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500 }}>
              Мульти-парсер: JacRed · Torrentio · Rutor · Jackett
            </div>
          </div>
        </div>

        {/* Keyword Search */}
        <div style={{ position: 'relative', width: '220px' }}>
          <Search size={13} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'rgba(240,242,248,0.3)', pointerEvents: 'none' }} />
          <input
            type="text"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="RHS, REMUX, DV..."
            className="input-glass"
            style={{ paddingLeft: '30px', height: '34px', fontSize: '0.78rem', borderRadius: '10px' }}
          />
        </div>
      </div>

      {/* ── Filter Chips Panel ── */}
      <div
        style={{
          padding: '0.85rem 1.4rem',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.55rem',
        }}
      >
        {/* Quality */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', minWidth: '68px' }}>Качество</span>
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            {qualityOptions.map(q => {
              const qs = q !== 'ALL' ? getQualityStyle(q) : null;
              const isActive = qualityFilter === q;
              return (
                <button
                  key={q}
                  onClick={() => setQualityFilter(q)}
                  className={`filter-chip ${isActive ? 'active-cyan' : ''}`}
                  style={isActive && qs ? {
                    background: qs.bg,
                    color: qs.color,
                    borderColor: qs.border,
                    boxShadow: `0 0 10px ${qs.glow}`,
                  } : {}}
                >
                  {q === 'ALL' ? 'Все' : q}
                </button>
              );
            })}
          </div>
        </div>

        {/* Dubbing */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: '0.3rem', minWidth: '68px' }}>
            <Volume2 size={11} style={{ color: 'var(--text-purple)' }} />
            Озвучка
          </span>
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            {dubbingOptions.map(d => {
              const ds = d !== 'ALL' ? getDubbingStyle(d) : null;
              const isActive = dubbingFilter === d;
              return (
                <button
                  key={d}
                  onClick={() => setDubbingFilter(d)}
                  className={`filter-chip ${isActive ? 'active-purple' : ''}`}
                  style={isActive && ds ? {
                    background: ds.bg,
                    color: ds.color,
                    borderColor: ds.border,
                    boxShadow: `0 0 10px ${ds.glow}`,
                  } : {}}
                >
                  {d === 'ALL' ? 'Все студии' : d}
                </button>
              );
            })}
          </div>
        </div>

        {/* Sort Selector (RU-first по умолчанию) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600 }}>Сортировать:</span>
          {[
            { id: 'russian',   label: 'RU + Сиды' },
            { id: 'seeders',   label: 'По сидам' },
            { id: 'stability', label: 'Smart Choice' },
            { id: 'size',      label: 'Размер' },
          ].map(opt => (
            <button
              key={opt.id}
              onClick={() => setSortBy(opt.id as any)}
              className={`filter-chip ${sortBy === opt.id ? 'active-cyan' : ''}`}
              style={{ fontSize: '0.7rem' }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Release List ── */}
      <div
        style={{
          padding: '0.6rem 0.8rem',
          maxHeight: '480px',
          overflowY: 'auto',
          // GPU-композитинг скролл-контейнера (микро-фризы на M1 при repaint)
          transform: 'translateZ(0)',
          willChange: 'transform',
        }}
      >
        {isLoading ? (
          <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {[1, 2, 3].map(n => (
              <div key={n} className="skeleton" style={{ height: '80px', borderRadius: '14px' }} />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center' }}>
            <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 0.75rem' }}>
              <Download size={20} style={{ color: 'var(--text-muted)' }} />
            </div>
            <p style={{ color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.25rem' }}>Раздачи не найдены</p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>Попробуйте изменить или сбросить фильтры</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {sorted.map((release, idx) => {
              const qs = getQualityStyle(release.quality);
              const ds = getDubbingStyle(release.dubbing);

              return (
                <div
                  key={release.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '1rem',
                    padding: '0.9rem 1rem',
                    borderRadius: '16px',
                    background: 'rgba(255,255,255,0.025)',
                    border: '1px solid rgba(255,255,255,0.05)',
                    transition: 'all 0.2s ease',
                    animation: `fadeUp 0.3s ease ${idx * 0.04}s both`,
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.05)';
                    (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(0,242,254,0.2)';
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.025)';
                    (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.05)';
                  }}
                >
                  {/* Health Ring */}
                  <HealthRing score={release.stabilityScore} label={release.stabilityLabel} />

                  {/* Main Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Top Badges Row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.45rem', flexWrap: 'wrap' }}>
                      {/* Quality */}
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: '6px',
                          background: qs.bg,
                          color: qs.color,
                          border: `1px solid ${qs.border}`,
                          fontSize: '0.68rem',
                          fontWeight: 900,
                          letterSpacing: '0.06em',
                          boxShadow: qs.glow ? `0 0 8px ${qs.glow}` : 'none',
                          textShadow: qs.glow ? `0 0 6px ${qs.color}` : 'none',
                        }}
                      >
                        {release.quality}
                      </span>

                      {/* Dubbing */}
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: '999px',
                          background: ds.bg,
                          color: ds.color,
                          border: `1px solid ${ds.border}`,
                          fontSize: '0.67rem',
                          fontWeight: 700,
                          boxShadow: `0 0 8px ${ds.glow}`,
                        }}
                      >
                        {release.dubbing}
                      </span>

                      {/* Tags (HDR, REMUX etc) */}
                      {release.tags.slice(0, 2).map(tag => (
                        <span key={tag} className="tag-chip">{tag}</span>
                      ))}

                      {/* Codec */}
                      <span className={`tag-chip ${release.videoCodec === 'HEVC' ? 'tag-chip-hevc' : release.videoCodec === 'AV1' ? 'tag-chip-av1' : ''}`}>
                        {release.videoCodec}
                      </span>

                      {/* HEVC Warning */}
                      {release.videoCodec === 'HEVC' && (
                        <span title="Требует поддержки HEVC декодирования" style={{ display: 'inline-flex' }}>
                          <AlertTriangle size={12} style={{ color: '#FFB800', opacity: 0.7 }} />
                        </span>
                      )}
                    </div>

                    {/* Release Title */}
                    <div
                      style={{
                        fontSize: '0.82rem',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        marginBottom: '0.3rem',
                      }}
                    >
                      {release.title}
                    </div>

                    {/* Meta Row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <HardDrive size={11} style={{ color: 'rgba(138,43,226,0.7)' }} />
                        {release.size}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: 'rgba(16,245,172,0.8)' }}>
                        <Users size={11} />
                        {release.seeders} seed
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                        <Zap size={11} style={{ color: 'rgba(255,184,0,0.6)' }} />
                        ~{release.requiredMbps} Mbps
                      </span>
                      <span style={{ color: 'rgba(240,242,248,0.25)', fontSize: '0.67rem' }}>
                        {release.source}
                      </span>
                    </div>

                    {/* ── Метаданные из названия: озвучки, серии/сезоны, аудио ── */}
                    {(metaOf(release).dubbings.length > 0 ||
                      metaOf(release).seasons ||
                      metaOf(release).episodes ||
                      metaOf(release).audioTracks.length > 0) && (
                      <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.45rem', alignItems: 'center' }}>
                        {metaOf(release).dubbings.slice(0, 4).map((d) => (
                          <span
                            key={d}
                            style={{
                              padding: '1px 7px',
                              borderRadius: '999px',
                              background: 'rgba(138,43,226,0.12)',
                              border: '1px solid rgba(138,43,226,0.35)',
                              color: '#B57BFF',
                              fontSize: '0.62rem',
                              fontWeight: 700,
                            }}
                          >
                            {d}
                          </span>
                        ))}
                        {metaOf(release).seasons != null && (
                          <span
                            style={{
                              padding: '1px 7px',
                              borderRadius: '999px',
                              background: 'rgba(16,245,172,0.1)',
                              border: '1px solid rgba(16,245,172,0.3)',
                              color: '#10F5AC',
                              fontSize: '0.62rem',
                              fontWeight: 700,
                            }}
                          >
                            S{metaOf(release).seasons}
                            {metaOf(release).episodes != null ? `E${metaOf(release).episodes}` : ''}
                          </span>
                        )}
                        {metaOf(release).episodes != null && metaOf(release).seasons == null && (
                          <span
                            style={{
                              padding: '1px 7px',
                              borderRadius: '999px',
                              background: 'rgba(16,245,172,0.1)',
                              border: '1px solid rgba(16,245,172,0.3)',
                              color: '#10F5AC',
                              fontSize: '0.62rem',
                              fontWeight: 700,
                            }}
                          >
                            {metaOf(release).episodes} серий
                          </span>
                        )}
                        {metaOf(release).audioTracks.slice(0, 3).map((a) => (
                          <span
                            key={a}
                            title="Аудиодорожка"
                            style={{
                              padding: '1px 6px',
                              borderRadius: '6px',
                              background: 'rgba(255,184,0,0.1)',
                              border: '1px solid rgba(255,184,0,0.3)',
                              color: '#FFB800',
                              fontSize: '0.6rem',
                              fontWeight: 700,
                            }}
                          >
                            {a}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Stream Action */}
                  <button
                    onClick={() => onPlayRelease(release)}
                    className="btn-primary"
                    style={{
                      padding: '0.55rem 1.1rem',
                      fontSize: '0.82rem',
                      flexShrink: 0,
                      borderRadius: '12px',
                    }}
                  >
                    <Play size={13} fill="white" />
                    <span>Смотреть</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
