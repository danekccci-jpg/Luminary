import React, { useMemo, useRef, useEffect, useState } from 'react';
import { X, Play, SkipForward, Tv, CheckCircle2, Clock, ChevronDown, ChevronRight, Mic } from 'lucide-react';
import { Movie, TorrentRelease } from '../types';
import { LibraryItem, library, formatClock } from '../services/library';
import { parseTorrentMeta } from '../utils/torrentMeta';
import { sanitizeTrackerName } from '../utils/trackerName';
import { toastBus } from '../services/toast';
import { useFocusTrap } from '../utils/focus';
import { registerBackHandler } from '../utils/tv';

interface EpisodeResumeDialogProps {
  movie: Movie;
  release: TorrentRelease;
  historyItem?: LibraryItem;
  releases: TorrentRelease[];
  /** Данные TMDB о сезонах (season_number + episode_count) для раскрытия сезонных пакетов. */
  tmdbSeasons?: Array<{ season_number: number; episode_count: number }>;
  onPlay: (release: TorrentRelease, opts: { season?: number; episode?: number; startPosition?: number }) => void;
  onClose: () => void;
}

function episodeOf(title: string): { season?: number; episode?: number } {
  const m = parseTorrentMeta(title || '');
  return { season: m.seasons ?? undefined, episode: m.episodes ?? undefined };
}

export function findRelease(releases: TorrentRelease[], season: number, episode: number): TorrentRelease | null {
  const matches = releases.filter((r) => {
    const e = episodeOf(r.title);
    return e.season === season && e.episode === episode;
  });
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.seeders - a.seeders)[0];
}

/**
 * Умное меню запуска серии:
 *  - Продолжить / Следующая серия / Выбрать серию (по истории);
 *  - Пикер сезонов (раскрывающиеся) → эпизодов (по раздачам + TMDB fallback).
 */
export const EpisodeResumeDialog: React.FC<EpisodeResumeDialogProps> = ({
  movie,
  release,
  historyItem,
  releases,
  tmdbSeasons,
  onPlay,
  onClose,
}) => {
  const [view, setView] = useState<'dialog' | 'picker'>(historyItem ? 'dialog' : 'picker');
  const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(new Set());
  const [selectedDubbing, setSelectedDubbing] = useState<string>('ALL');

  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(true, dialogRef);
  useEffect(() => registerBackHandler(() => { onClose(); return true; }), [onClose]);

  /** Все уникальные озвучки из раздач (вкл. из названий). */
  const availableDubbings = useMemo(() => {
    const map = new Map<string, number>(); // дуббинг → кол-во раздач
    for (const r of releases) {
      const meta = parseTorrentMeta(r.title);
      const dubs = meta.dubbings.length > 0 ? meta.dubbings : [r.dubbing || 'Прочее'];
      for (const d of dubs) map.set(d, (map.get(d) || 0) + 1);
    }
    // Сортировка: по количеству раздач (больше = популярнее)
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [releases]);

  /** Раздачи, отфильтрованные по выбранной озвучке. */
  const filteredReleases = useMemo(() => {
    if (selectedDubbing === 'ALL') return releases;
    return releases.filter((r) => {
      const meta = parseTorrentMeta(r.title);
      return meta.dubbings.includes(selectedDubbing) || r.dubbing === selectedDubbing;
    });
  }, [releases, selectedDubbing]);

  const season = historyItem?.season;
  const episode = historyItem?.episode;
  const pct =
    historyItem?.progressPercentage ??
    (historyItem?.duration && historyItem?.position
      ? Math.round((historyItem.position / historyItem.duration) * 100)
      : 0);
  const watched = pct > 95;

  /** Прогресс по эпизодам. */
  const progressByEpisode = useMemo(() => {
    const map = new Map<string, LibraryItem>();
    for (const h of library.getHistory()) {
      if (h.id === String(movie.id) && h.season != null && h.episode != null) {
        map.set(`${h.season}-${h.episode}`, h);
      }
    }
    return map;
  }, [movie.id]);

  /** Сезоны → серии из ОТФИЛЬТРОВАННЫХ по озвучке раздач + TMDB fallback. */
  const episodesBySeason = useMemo(() => {
    const map = new Map<number, Set<number>>();
    // 1) Собираем индивидуальные эпизоды из названий отфильтрованных раздач
    for (const r of filteredReleases) {
      const e = episodeOf(r.title);
      if (e.season == null || e.episode == null) continue;
      if (!map.has(e.season)) map.set(e.season, new Set());
      map.get(e.season)!.add(e.episode);
    }
    // 2) Если TMDB знает сезоны — добавляем эпизоды для сезонов без индивидуальных раздач
    if (tmdbSeasons && tmdbSeasons.length > 0) {
      for (const ts of tmdbSeasons) {
        const s = ts.season_number;
        if (s <= 0) continue; // сезон 0 = specials, пропускаем
        if (!map.has(s)) map.set(s, new Set());
        const existing = map.get(s)!;
        // Заполняем недостающие номера эпизодов (1..episode_count)
        for (let ep = 1; ep <= ts.episode_count; ep++) {
          if (!existing.has(ep)) existing.add(ep);
        }
      }
    }
    return [...map.entries()]
      .map(([s, eps]) => ({ season: s, episodes: [...eps].sort((a, b) => a - b) }))
      .sort((a, b) => a.season - b.season);
  }, [filteredReleases, tmdbSeasons, selectedDubbing]);

  // Авто-раскрыть текущий сезон (из истории) + авто-выбор озвучки
  useEffect(() => {
    if (season != null) setExpandedSeasons(new Set([season]));
    // Если история запомнена — попробуем подобрать озвучку из раздач
    if (historyItem?.id && releases.length > 0) {
      const match = releases.find((r) => {
        const ep = episodeOf(r.title);
        return ep.season === historyItem.season && ep.episode === historyItem.episode;
      });
      if (match) {
        const meta = parseTorrentMeta(match.title);
        if (meta.dubbings.length > 0) setSelectedDubbing(meta.dubbings[0]);
        else if (match.dubbing && match.dubbing !== 'Прочее') setSelectedDubbing(match.dubbing);
      }
    }
  }, [season, historyItem]);

  const toggleSeason = (s: number) => {
    setExpandedSeasons((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  };

  const expandAll = () => setExpandedSeasons(new Set(episodesBySeason.map((s) => s.season)));
  const collapseAll = () => setExpandedSeasons(new Set());

  const playEpisode = (s: number, e: number, startPosition?: number) => {
    const rel = findRelease(filteredReleases, s, e) || release;
    onPlay(rel, { season: s, episode: e, startPosition });
  };

  const handleContinue = () => {
    if (season == null || episode == null) { onClose(); return; }
    playEpisode(season, episode, historyItem?.position);
  };

  const handleNext = () => {
    if (season == null || episode == null) return;
    const next = findRelease(filteredReleases, season, episode + 1);
    if (!next) {
      toastBus.push(`Раздача S${String(season).padStart(2, '0')}E${String(episode + 1).padStart(2, '0')} не найдена`, 'error');
      setView('picker');
      return;
    }
    playEpisode(season, episode + 1);
  };

  const handlePickEpisode = (s: number, e: number) => {
    const h = progressByEpisode.get(`${s}-${e}`);
    const pos = h && h.position && h.duration && h.position > 5 && h.position < h.duration - 10 ? h.position : undefined;
    playEpisode(s, e, pos);
  };

  const epLabel = (s: number, e: number) => `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`;
  const totalEpisodes = episodesBySeason.reduce((acc, s) => acc + s.episodes.length, 0);

  return (
    <div
      ref={dialogRef}
      style={{
        position: 'fixed', inset: 0, zIndex: 70,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1.5rem',
        background: 'rgba(0,0,0,0.82)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
        animation: 'fadeIn 0.2s ease',
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          position: 'relative', width: '100%', maxWidth: '560px', maxHeight: '85vh', overflowY: 'auto',
          background: 'rgba(11,12,17,0.985)', border: '1px solid rgba(0,242,254,0.2)',
          borderRadius: '28px', padding: '2rem',
          boxShadow: '0 32px 80px rgba(0,0,0,0.9)', animation: 'scaleIn 0.3s cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: '1rem', right: '1rem', width: '34px', height: '34px',
            borderRadius: '50%', background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(240,242,248,0.5)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <X size={14} />
        </button>

        {view === 'dialog' && season != null && episode != null ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', marginBottom: '1.2rem' }}>
              <div style={{
                width: '40px', height: '40px', borderRadius: '12px',
                background: 'linear-gradient(135deg, rgba(0,198,251,0.2), rgba(138,43,226,0.2))',
                border: '1px solid rgba(0,242,254,0.25)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <Tv size={17} style={{ color: 'var(--cyan)' }} />
              </div>
              <div>
                <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                  {movie.title || movie.name}
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  Просмотрено {pct}% эпизода {epLabel(season, episode)}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <button
                onClick={handleContinue}
                className="btn-primary"
                style={{ borderRadius: '14px', padding: '0.8rem 1.2rem', fontSize: '0.85rem', justifyContent: 'flex-start', textAlign: 'left' }}
              >
                <Play size={15} fill="white" style={{ flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  Продолжить ({epLabel(season, episode)})
                </span>
                {historyItem?.position ? (
                  <span style={{ marginLeft: 'auto', fontSize: '0.7rem', opacity: 0.75, flexShrink: 0 }}>
                    {formatClock(historyItem.position)}
                  </span>
                ) : null}
              </button>

              {watched && (
                <button
                  onClick={handleNext}
                  className="btn-primary"
                  style={{ borderRadius: '14px', padding: '0.8rem 1.2rem', fontSize: '0.85rem', justifyContent: 'flex-start', textAlign: 'left', background: 'linear-gradient(135deg, #8A2BE2, #D946EF)' }}
                >
                  <SkipForward size={15} style={{ flexShrink: 0 }} />
                  <span>Следующая ({epLabel(season, episode + 1)})</span>
                </button>
              )}

              <button
                onClick={() => setView('picker')}
                className="btn-secondary"
                style={{ borderRadius: '14px', padding: '0.8rem 1.2rem', fontSize: '0.85rem', justifyContent: 'flex-start', textAlign: 'left' }}
              >
                <Tv size={15} style={{ flexShrink: 0 }} />
                <span>Выбрать серию</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', marginBottom: '1rem' }}>
              <div style={{
                width: '40px', height: '40px', borderRadius: '12px',
                background: 'linear-gradient(135deg, rgba(0,198,251,0.2), rgba(138,43,226,0.2))',
                border: '1px solid rgba(0,242,254,0.25)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <Tv size={17} style={{ color: 'var(--cyan)' }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                  {movie.title || movie.name}
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  {totalEpisodes > 0
                    ? `${episodesBySeason.length} сезонов · ${totalEpisodes} эпизодов`
                    : 'Серии не распознаны — воспроизведите раздачу напрямую'}
                </div>
              </div>
              {episodesBySeason.length > 1 && (
                <button
                  onClick={() => expandedSeasons.size === episodesBySeason.length ? collapseAll() : expandAll()}
                  style={{
                    border: 'none', background: 'rgba(255,255,255,0.06)', borderRadius: '8px',
                    padding: '0.3rem 0.6rem', color: 'var(--text-muted)', cursor: 'pointer',
                    fontSize: '0.68rem', fontWeight: 600, flexShrink: 0,
                  }}
                >
                  {expandedSeasons.size === episodesBySeason.length ? 'Свернуть' : 'Развернуть все'}
                </button>
              )}
            </div>

            {episodesBySeason.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                Не удалось определить серии — используйте список раздач ниже
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {episodesBySeason.map(({ season: s, episodes }) => {
                  const isExpanded = expandedSeasons.has(s);
                  const watchedInSeason = episodes.filter((e) => {
                    const h = progressByEpisode.get(`${s}-${e}`);
                    const p = h?.progressPercentage ?? (h?.position && h?.duration ? Math.round((h.position / h.duration) * 100) : 0);
                    return p > 95;
                  }).length;
                  return (
                    <div key={s} style={{
                      border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', overflow: 'hidden',
                    }}>
                      <button
                        onClick={() => toggleSeason(s)}
                        style={{
                          width: '100%', padding: '0.7rem 1rem', display: 'flex', alignItems: 'center', gap: '0.6rem',
                          background: isExpanded ? 'rgba(0,242,254,0.04)' : 'rgba(255,255,255,0.02)',
                          border: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontFamily: 'inherit',
                          transition: 'background 0.15s ease',
                        }}
                      >
                        {isExpanded ? <ChevronDown size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} /> : <ChevronRight size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
                        <span style={{ fontSize: '0.78rem', fontWeight: 700 }}>Сезон {s}</span>
                        <span style={{ fontSize: '0.66rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                          {episodes.length} серий
                        </span>
                        {watchedInSeason > 0 && (
                          <span style={{ marginLeft: 'auto', fontSize: '0.64rem', color: 'var(--emerald)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '3px' }}>
                            <CheckCircle2 size={11} />{watchedInSeason}
                          </span>
                        )}
                      </button>
                      {isExpanded && (
                        <div style={{ padding: '0.5rem 0.7rem 0.7rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))', gap: '0.35rem' }}>
                          {episodes.map((e) => {
                            const h = progressByEpisode.get(`${s}-${e}`);
                            const hpct = h?.progressPercentage ?? (h?.position && h?.duration ? Math.round((h.position / h.duration) * 100) : 0);
                            const w = hpct > 95;
                            const ip = hpct > 5 && !w;
                            return (
                              <button
                                key={e}
                                onClick={() => handlePickEpisode(s, e)}
                                title={`${epLabel(s, e)}${ip ? ` · ${hpct}%` : ''}`}
                                style={{
                                  padding: '0.4rem 0.15rem', borderRadius: '8px', fontFamily: 'inherit',
                                  border: `1px solid ${w ? 'rgba(16,245,172,0.4)' : ip ? 'rgba(255,184,0,0.4)' : 'rgba(255,255,255,0.08)'}`,
                                  background: w ? 'rgba(16,245,172,0.08)' : ip ? 'rgba(255,184,0,0.07)' : 'rgba(255,255,255,0.03)',
                                  color: w ? 'var(--emerald)' : ip ? '#FFB800' : 'var(--text-muted)',
                                  fontSize: '0.68rem', fontWeight: 700, cursor: 'pointer',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '2px',
                                  transition: 'all 0.12s ease',
                                }}
                                onMouseEnter={(ev) => { ev.currentTarget.style.borderColor = 'rgba(0,242,254,0.5)'; ev.currentTarget.style.color = 'var(--cyan)'; }}
                                onMouseLeave={(ev) => {
                                  ev.currentTarget.style.borderColor = w ? 'rgba(16,245,172,0.4)' : ip ? 'rgba(255,184,0,0.4)' : 'rgba(255,255,255,0.08)';
                                  ev.currentTarget.style.color = w ? 'var(--emerald)' : ip ? '#FFB800' : 'var(--text-muted)';
                                }}
                              >
                                {w ? <CheckCircle2 size={10} /> : ip ? <Clock size={10} /> : null}
                                {e}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ── Пикер озвучки (только в picker-режиме если есть варианты) ── */}
        {view === 'picker' && availableDubbings.length > 1 && (
          <div style={{ marginTop: '1.2rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}>
              <Mic size={13} style={{ color: 'var(--cyan)' }} />
              <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)' }}>Озвучка</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              <button
                onClick={() => setSelectedDubbing('ALL')}
                style={{
                  padding: '0.35rem 0.7rem', borderRadius: '8px', border: '1px solid',
                  borderColor: selectedDubbing === 'ALL' ? 'rgba(0,242,254,0.4)' : 'rgba(255,255,255,0.08)',
                  background: selectedDubbing === 'ALL' ? 'rgba(0,242,254,0.12)' : 'rgba(255,255,255,0.03)',
                  color: selectedDubbing === 'ALL' ? 'var(--cyan)' : 'var(--text-muted)',
                  fontSize: '0.68rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                Все
              </button>
              {availableDubbings.map(({ name, count }) => (
                <button
                  key={name}
                  onClick={() => setSelectedDubbing(name)}
                  style={{
                    padding: '0.35rem 0.7rem', borderRadius: '8px', border: '1px solid',
                    borderColor: selectedDubbing === name ? 'rgba(0,242,254,0.4)' : 'rgba(255,255,255,0.08)',
                    background: selectedDubbing === name ? 'rgba(0,242,254,0.12)' : 'rgba(255,255,255,0.03)',
                    color: selectedDubbing === name ? 'var(--cyan)' : 'var(--text-muted)',
                    fontSize: '0.68rem', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                    display: 'flex', alignItems: 'center', gap: '0.3rem',
                  }}
                >
                  <span>{name}</span>
                  <span style={{ fontSize: '0.6rem', opacity: 0.6 }}>{count}</span>
                </button>
              ))}
            </div>
            {selectedDubbing !== 'ALL' && (
              <div style={{ marginTop: '0.5rem', fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                {filteredReleases.length} раздач · {episodesBySeason.length} сезонов · {episodesBySeason.reduce((a, s) => a + s.episodes.length, 0)} серий
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
