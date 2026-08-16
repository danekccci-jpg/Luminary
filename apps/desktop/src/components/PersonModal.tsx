/**
 * PersonModal.tsx — страница актёра: биография + фильмография.
 *
 * Открывается по клику на карточку актёра в деталях фильма (оверлей zIndex 70
 * поверх MovieDetailsModal). Данные — TMDB /person/{id} + combined_credits
 * (кэш 24ч). Клик по фильму фильмографии закрывает актёрскую модалку и
 * переключает детали на выбранный фильм.
 */
import React, { useEffect, useRef, useState } from 'react';
import { X, User, Clapperboard, Film } from 'lucide-react';
import { Movie, Person } from '../types';
import { tmdbService } from '../services/tmdb';
import { extractYear } from '../utils/year';
import { useFocusTrap } from '../utils/focus';
import { registerBackHandler } from '../utils/tv';

interface PersonModalProps {
  personId: number;
  onClose: () => void;
  /** Открыть детали выбранного фильма (переключение внутри той же модалки). */
  onSelectMovie: (movie: Movie) => void;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** '1954-04-16' → «16 апреля 1954» (пусто — null). */
function formatDate(date?: string | null): string | null {
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  if (!y) return null;
  const month = m >= 1 && m <= 12 ? MONTHS[m - 1] : '';
  return d ? `${d} ${month} ${y}` : `${y}`;
}

export const PersonModal: React.FC<PersonModalProps> = ({ personId, onClose, onSelectMovie }) => {
  const [person, setPerson] = useState<Person | null>(null);
  const [loading, setLoading] = useState(true);
  const modalRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(true, modalRef);
  useEffect(() => registerBackHandler(() => { onClose(); return true; }), [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    tmdbService
      .getPerson(personId)
      .then((p) => {
        if (!cancelled) setPerson(p);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [personId]);

  const photo = tmdbService.getImageUrl(person?.profile_path, 'w300');
  const credits = person?.credits || [];
  const born = person ? formatDate(person.birthday) : null;
  const died = person ? formatDate(person.deathday) : null;

  return (
    <div
      ref={modalRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        background: 'rgba(0,0,0,0.78)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
        animation: 'fadeIn 0.15s ease',
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Актёр"
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: '640px',
          maxHeight: '86vh',
          overflowY: 'auto',
          background: 'rgba(13,15,21,0.99)',
          border: '1px solid rgba(255,255,255,0.09)',
          borderRadius: '24px',
          boxShadow: '0 32px 80px rgba(0,0,0,0.85)',
          animation: 'scaleIn 0.28s cubic-bezier(0.16,1,0.3,1)',
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(255,255,255,0.14) transparent',
        }}
      >
        {/* ── Header: фото + имя + мета ── */}
        <div style={{ padding: '1.6rem 1.6rem 1.2rem', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', gap: '1.1rem', alignItems: 'flex-start' }}>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            style={{
              position: 'absolute',
              top: '1rem',
              right: '1rem',
              width: '30px',
              height: '30px',
              borderRadius: '8px',
              background: 'transparent',
              border: '1px solid transparent',
              color: 'rgba(237,241,247,0.45)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(237,241,247,0.45)'; }}
          >
            <X size={15} />
          </button>

          <div
            style={{
              width: '92px',
              height: '120px',
              borderRadius: '12px',
              overflow: 'hidden',
              flexShrink: 0,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {photo ? (
              <img
                src={photo}
                alt={person?.name || 'Актёр'}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                onError={(e) => {
                  const img = e.currentTarget as HTMLImageElement;
                  img.style.display = 'none';
                }}
              />
            ) : (
              <User size={26} style={{ color: 'rgba(237,241,247,0.3)' }} />
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0, paddingRight: '2rem' }}>
            <div style={{ fontSize: '1.15rem', fontWeight: 800, letterSpacing: '-0.01em', color: '#F0F2F8', lineHeight: 1.2 }}>
              {person?.name || 'Актёр'}
            </div>
            {(born || died) && (
              <div style={{ fontSize: '0.74rem', color: 'rgba(237,241,247,0.5)', marginTop: '6px', lineHeight: 1.5 }}>
                {died ? `${born || '—'} — ${died}` : born ? `Родился: ${born}` : ''}
                {person?.place_of_birth ? ` · ${person.place_of_birth}` : ''}
              </div>
            )}
            {credits.length > 0 && (
              <div style={{ marginTop: '10px', display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '2px 9px', borderRadius: '999px', background: 'rgba(110,168,254,0.1)', border: '1px solid rgba(110,168,254,0.28)', color: '#8FBDFF', fontSize: '0.68rem', fontWeight: 700 }}>
                <Film size={11} />
                {credits.length} фильмов
              </div>
            )}
          </div>
        </div>

        {/* ── Биография ── */}
        {!loading && person && (
          <div style={{ padding: '1.2rem 1.6rem 0' }}>
            <div style={{ fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'rgba(237,241,247,0.45)', marginBottom: '8px' }}>
              Биография
            </div>
            <p style={{ fontSize: '0.82rem', color: 'rgba(237,241,247,0.65)', lineHeight: 1.65, margin: 0 }}>
              {person.biography || 'Биография пока недоступна.'}
            </p>
          </div>
        )}

        {/* ── Фильмография ── */}
        <div style={{ padding: '1.4rem 1.6rem 1.8rem' }}>
          <div style={{ fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.11em', textTransform: 'uppercase', color: 'rgba(237,241,247,0.45)', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Clapperboard size={13} style={{ color: 'var(--tint-strong)' }} />
            Фильмография
          </div>

          {loading ? (
            <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <div key={n} className="skeleton" style={{ width: '110px', height: '165px', borderRadius: '10px' }} />
              ))}
            </div>
          ) : !person ? (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Не удалось загрузить данные актёра.</p>
          ) : credits.length === 0 ? (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Фильмография пока пуста.</p>
          ) : (
            <div style={{ display: 'flex', gap: '0.7rem', overflowX: 'auto', paddingBottom: '0.5rem' }} className="scrollbar-none">
              {credits.map((credit) => (
                <button
                  key={String(credit.id)}
                  onClick={() => onSelectMovie(credit)}
                  title={`${credit.title}${credit.character ? ` — ${credit.character}` : ''}`}
                  style={{
                    flexShrink: 0,
                    width: '112px',
                    textAlign: 'left',
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  <div
                    style={{
                      width: '112px',
                      height: '168px',
                      borderRadius: '10px',
                      overflow: 'hidden',
                      background: 'rgba(255,255,255,0.035)',
                      border: '1px solid rgba(255,255,255,0.07)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'border-color 0.15s ease, transform 0.15s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = 'rgba(110,168,254,0.45)';
                      e.currentTarget.style.transform = 'translateY(-2px)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)';
                      e.currentTarget.style.transform = 'translateY(0)';
                    }}
                  >
                    {credit.poster_path ? (
                      <img
                        src={tmdbService.getImageUrl(credit.poster_path, 'w300')}
                        alt={credit.title}
                        loading="lazy"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <Film size={20} style={{ color: 'rgba(237,241,247,0.25)' }} />
                    )}
                  </div>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#E9EDF4', marginTop: '6px', lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {credit.title}
                  </div>
                  <div style={{ fontSize: '0.64rem', color: 'rgba(237,241,247,0.4)', marginTop: '3px', lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {credit.character ? `${extractYear(credit.release_date)} · ${credit.character}` : extractYear(credit.release_date) || ''}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
