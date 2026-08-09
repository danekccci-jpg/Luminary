/**
 * TorrentCard.tsx — карточка торрент-раздачи (дизайн по образцу UI):
 * тёмная карточка rounded-xl с полупрозрачным фоном, 2-строчное название,
 * ряд тегов-пилюль (🎙️ озвучки, 💬 субтитры), футер: дата + трекер слева,
 * битрейт / раздают / качают / размер-плашка справа.
 * Вся карточка кликабельна (role=button, Enter/Space через keyActivate).
 */
import React, { useState } from 'react';
import { TorrentRelease } from '../types';
import { parseTorrentTags } from '../utils/torrentParser';
import { sanitizeTrackerName } from '../utils/trackerName';
import { keyActivate } from '../utils/focus';

interface TorrentCardProps {
  release: TorrentRelease;
  /** Клик/Enter/Space по карточке. */
  onPlay: () => void;
  /** Порядковый номер — для каскадной анимации появления. */
  index?: number;
}

/** Размер в человекочитаемом виде: «77.77 ГБ», «1.2 ГБ», «850 МБ». */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} ГБ`;
  const mb = bytes / 1024 ** 2;
  return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} МБ`;
}

export const TorrentCard: React.FC<TorrentCardProps> = ({ release, onPlay, index = 0 }) => {
  const tags = parseTorrentTags(release.title);
  const [focused, setFocused] = useState(false);

  const pill = (label: string, icon?: string) => (
    <span key={label} className="torrent-card-pill">
      {icon ? `${icon} ${label}` : label}
    </span>
  );

  return (
    <div
      className={`torrent-card${focused ? ' torrent-card-focused' : ''}`}
      tabIndex={0}
      role="button"
      aria-label={`Смотреть: ${release.title}`}
      onClick={onPlay}
      onKeyDown={(e) => keyActivate(e, onPlay)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{ animation: `fadeUp 0.3s ease ${index * 0.04}s both` }}
    >
      {/* Оригинальное полное имя раздачи (2 строки) */}
      <div className="torrent-card-title">{release.title}</div>

      {/* Ряд тегов: качество, форматы, аудио, 🎙️ озвучки, 💬 субтитры */}
      <div className="torrent-card-tags">
        {pill(tags.quality)}
        {tags.formats.map((f) => pill(f))}
        {tags.audio.map((a) => pill(a))}
        {tags.dubbing.map((d) => pill(d, '🎙️'))}
        {tags.subtitles.map((s) => pill(s, '💬'))}
      </div>

      {/* Футер: слева дата + трекер, справа битрейт / сиды / пиры / размер */}
      <footer className="torrent-card-footer">
        <div className="torrent-card-meta-left">
          {tags.year && <span>{tags.year}</span>}
          <span className="torrent-card-tracker">{sanitizeTrackerName(release.source).toLowerCase()}</span>
        </div>
        <div className="torrent-card-meta-right">
          <span>~{tags.bitrateMbps ?? release.requiredMbps} Мбит/с</span>
          <span>Раздают: {release.seeders}</span>
          <span>Качают: {release.leechers}</span>
          <span className="torrent-card-size">{formatSize(release.sizeBytes)}</span>
        </div>
      </footer>
    </div>
  );
};
