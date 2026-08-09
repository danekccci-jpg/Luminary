import React, { useMemo, useState } from 'react';
import { X, Play, SkipForward, Tv, CheckCircle2, Clock } from 'lucide-react';
import { Movie, TorrentRelease } from '../types';
import { LibraryItem, library, formatClock } from '../services/library';
import { parseTorrentMeta } from '../utils/torrentMeta';
import { toastBus } from '../services/toast';

interface EpisodeResumeDialogProps {
  movie: Movie;
  /** Раздача, по которой кликнули (fallback, если раздача конкретной серии не найдена). */
  release: TorrentRelease;
  /** Последний эпизод из истории (прогресс). Без него — сразу выбор серии. */
  historyItem?: LibraryItem;
  /** Все раздачи — для поиска раздач конкретных серий. */
  releases: TorrentRelease[];
  onPlay: (release: TorrentRelease, opts: { season?: number; episode?: number; startPosition?: number }) => void;
  onClose: () => void;
}

function episodeOf(title: string): { season?: number; episode?: number } {
  const m = parseTorrentMeta(title || '');
  return { season: m.seasons ?? undefined, episode: m.episodes ?? undefined };
}

/** Лучшая раздача серии (максимум сидов). */
export function findRelease(releases: TorrentRelease[], season: number, episode: number): TorrentRelease | null {
  const matches = releases.filter((r) => {
    const e = episodeOf(r.title);
    return e.season === season && e.episode === episode;
  });
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.seeders - a.seeders)[0];
}

/**
 * Умное меню запуска серии (Episode Resume & Selector):
 *  - Диалог «Продолжить / Следующая серия / Выбрать серию» по прогрессу истории;
 *  - Пикер всех сезонов и серий из найденных раздач (с прогрессом просмотра).
 */
export const EpisodeResumeDialog: React.FC<EpisodeResumeDialogProps> = ({
  movie,
  release,
  historyItem,
  releases,
  onPlay,
  onClose,
}) => {
  const [view, setView] = useState<'dialog' | 'picker'>(historyItem ? 'dialog' : 'picker');

  const season = historyItem?.season;
  const episode = historyItem?.episode;
  const pct =
    historyItem?.progressPercentage ??
    (historyItem?.duration && historyItem?.position
      ? Math.round((historyItem.position / historyItem.duration) * 100)
      : 0);
  const watched = pct > 95;

  /** Прогресс по эпизодам (id + season-episode) для меток в пикере. */
  const progressByEpisode = useMemo(() => {
    const map = new Map<string, LibraryItem>();
    for (const h of library.getHistory()) {
      if (h.id === String(movie.id) && h.season != null && h.episode != null) {
        map.set(`${h.season}-${h.episode}`, h);
      }
    }
    return map;
  }, [movie.id]);

  /** Сезоны → серии, собранные из всех раздач. */
  const episodesBySeason = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const r of releases) {
      const e = episodeOf(r.title);
      if (e.season == null || e.episode == null) continue;
      if (!map.has(e.season)) map.set(e.season, new Set());
      map.get(e.season)!.add(e.episode);
    }
    return [...map.entries()]
      .map(([s, eps]) => ({ season: s, episodes: [...eps].sort((a, b) => a - b) }))
      .sort((a, b) => a.season - b.season);
  }, [releases]);

  const playEpisode = (s: number, e: number, startPosition?: number) => {
    const rel = findRelease(releases, s, e) || release;
    onPlay(rel, { season: s, episode: e, startPosition });
  };

  const handleContinue = () => {
    if (season == null || episode == null) { onClose(); return; }
    playEpisode(season, episode, historyItem?.position);
  };

  const handleNext = () => {
    if (season == null || episode == null) return;
    const next = findRelease(releases, season, episode + 1);
    if (!next) {
      toastBus.push(`Раздача S${season}E${episode + 1} не найдена — выберите серию вручную`, 'error');
      setView('picker');
      return;
    }
    playEpisode(season, episode + 1);
  };

  const handlePickEpisode = (s: number, e: number) => {
    const h = progressByEpisode.get(`${s}-${e}`);
    const pos =
      h && h.position && h.duration && h.position > 5 && h.position < h.duration - 10
        ? h.position
        : undefined;
    playEpisode(s, e, pos);
  };

  const epLabel = (s: number, e: number) => `S${s}E${e}`;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        background: 'rgba(0,0,0,0.82)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        animation: 'fadeIn 0.2s ease',
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '560px',
          maxHeight: '85vh',
          overflowY: 'auto',
          background: 'rgba(11,12,17,0.985)',
          border: '1px solid rgba(0,242,254,0.2)',
          borderRadius: '28px',
          padding: '2rem',
          boxShadow: '0 32px 80px rgba(0,0,0,0.9)',
          animation: 'scaleIn 0.3s cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        {/* Close */}
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
          }}
        >
          <X size={14} />
        </button>

        {view === 'dialog' && season != null && episode != null ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', marginBottom: '1.2rem' }}>
              <div
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '12px',
                  background: 'linear-gradient(135deg, rgba(0,198,251,0.2), rgba(138,43,226,0.2))',
                  border: '1px solid rgba(0,242,254,0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
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
              {/* Продолжить просмотр */}
              <button
                onClick={handleContinue}
                className="btn-primary"
                style={{ borderRadius: '14px', padding: '0.8rem 1.2rem', fontSize: '0.85rem', justifyContent: 'flex-start', textAlign: 'left' }}
              >
                <Play size={15} fill="white" style={{ flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  Продолжить просмотр ({epLabel(season, episode)} — {movie.title})
                </span>
                {historyItem?.position ? (
                  <span style={{ marginLeft: 'auto', fontSize: '0.7rem', opacity: 0.75, flexShrink: 0 }}>
                    {formatClock(historyItem.position)}
                  </span>
                ) : null}
              </button>

              {/* Следующая серия (только если текущая досмотрена > 95%) */}
              {watched && (
                <button
                  onClick={handleNext}
                  className="btn-primary"
                  style={{
                    borderRadius: '14px',
                    padding: '0.8rem 1.2rem',
                    fontSize: '0.85rem',
                    justifyContent: 'flex-start',
                    textAlign: 'left',
                    background: 'linear-gradient(135deg, #8A2BE2, #D946EF)',
                  }}
                >
                  <SkipForward size={15} style={{ flexShrink: 0 }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    Следующая серия ({epLabel(season, episode + 1)} — {movie.title})
                  </span>
                </button>
              )}

              {/* Выбрать серию */}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', marginBottom: '1.2rem' }}>
              <div
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '12px',
                  background: 'linear-gradient(135deg, rgba(0,198,251,0.2), rgba(138,43,226,0.2))',
                  border: '1px solid rgba(0,242,254,0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Tv size={17} style={{ color: 'var(--cyan)' }} />
              </div>
              <div>
                <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                  {movie.title || movie.name} — серии
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  {episodesBySeason.length > 0
                    ? `${episodesBySeason.reduce((acc, s) => acc + s.episodes.length, 0)} эпизодов в раздачах`
                    : 'Серии не распознаны в названиях раздач — воспроизведите раздачу напрямую'}
                </div>
              </div>
            </div>

            {episodesBySeason.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                Не удалось определить серии — используйте список раздач ниже
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {episodesBySeason.map(({ season: s, episodes }) => (
                  <div key={s}>
                    <div style={{ fontSize: '0.68rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(0,242,254,0.55)', marginBottom: '0.5rem' }}>
                      Сезон {s}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: '0.4rem' }}>
                      {episodes.map((e) => {
                        const h = progressByEpisode.get(`${s}-${e}`);
                        const hpct = h?.progressPercentage ?? (h?.position && h?.duration ? Math.round((h.position / h.duration) * 100) : 0);
                        const watchedEp = hpct > 95;
                        const inProgress = hpct > 5 && !watchedEp;
                        return (
                          <button
                            key={e}
                            onClick={() => handlePickEpisode(s, e)}
                            title={`${epLabel(s, e)} — ${h?.title || movie.title}${inProgress ? ` · просмотрено ${hpct}%` : ''}`}
                            style={{
                              position: 'relative',
                              padding: '0.5rem 0.2rem',
                              borderRadius: '10px',
                              border: `1px solid ${
                                watchedEp
                                  ? 'rgba(16,245,172,0.4)'
                                  : inProgress
                                  ? 'rgba(255,184,0,0.4)'
                                  : 'rgba(255,255,255,0.08)'
                              }`,
                              background: watchedEp
                                ? 'rgba(16,245,172,0.08)'
                                : inProgress
                                ? 'rgba(255,184,0,0.07)'
                                : 'rgba(255,255,255,0.03)',
                              color: watchedEp ? 'var(--emerald)' : inProgress ? '#FFB800' : 'var(--text-muted)',
                              fontFamily: 'inherit',
                              fontSize: '0.72rem',
                              fontWeight: 700,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '0.25rem',
                              transition: 'all 0.15s ease',
                            }}
                            onMouseEnter={(ev) => {
                              ev.currentTarget.style.borderColor = 'rgba(0,242,254,0.5)';
                              ev.currentTarget.style.color = 'var(--cyan)';
                            }}
                            onMouseLeave={(ev) => {
                              ev.currentTarget.style.borderColor = watchedEp
                                ? 'rgba(16,245,172,0.4)'
                                : inProgress
                                ? 'rgba(255,184,0,0.4)'
                                : 'rgba(255,255,255,0.08)';
                              ev.currentTarget.style.color = watchedEp ? 'var(--emerald)' : inProgress ? '#FFB800' : 'var(--text-muted)';
                            }}
                          >
                            {watchedEp ? <CheckCircle2 size={11} /> : inProgress ? <Clock size={11} /> : null}
                            E{e}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
