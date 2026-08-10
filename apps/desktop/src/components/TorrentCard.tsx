/**
 * TorrentCard.tsx — карточка торрент-раздачи.
 *
 * Иерархия:
 *   · Заголовок (макс. 2 строки)
 *   · Ряд «спека»: качество (акцентный чип) + кодеки/контейнеры (острые чипы)
 *   · Ряд «аудио/языки»: дорожки (violet), озвучки (зелёные, с точкой), субтитры (пунктир)
 *   · Футер: год · трекер · индикатор здоровья слева; битрейт / сиды / пиры / размер справа
 *
 * Цвета карточки привязаны к ПЛАТФОРМЕ (трекеру), а не к качеству файла:
 *   RuTracker=amber, JacRed=ice, Torrentio=violet, NNM=emerald, Rutor=steel, other=neutral.
 * Сигнатура — цветная «рельса» платформы слева (2px), подсвечивается при hover/focus.
 * Вся карточка кликабельна (role=button, Enter/Space через keyActivate).
 */
import React, { useState } from 'react';
import { TorrentRelease } from '../types';
import { parseTorrentTags } from '../utils/torrentParser';
import { parseTorrentMeta } from '../utils/torrentMeta';
import { sanitizeTrackerName } from '../utils/trackerName';
import { keyActivate } from '../utils/focus';
import { Activity, ArrowDown, ArrowUp } from 'lucide-react';

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

/** Единый вид разрешения: FHD → 1080p, HD → 720p (SD остаётся SD). */
function normalizeQuality(tagsQuality: string, releaseQuality: string): string {
  const q = releaseQuality || tagsQuality;
  if (q === '4K') return '4K';
  if (q === 'FHD' || q === '1080p') return '1080p';
  if (q === 'HD' || q === '720p') return '720p';
  return 'SD';
}

/** Класс цвета карточки по платформе (трекеру). */
const PLATFORM_CLASS: Record<string, string> = {
  'RuTracker': 'plat-ru',
  'JacRed':    'plat-jac',
  'Torrentio': 'plat-tio',
  'NNM-Club':  'plat-nnm',
  'Rutor':     'plat-rutor',
};

function platformClass(source: string): string {
  return PLATFORM_CLASS[sanitizeTrackerName(source)] || 'plat-other';
}

/** Класс здоровья раздачи по индексу стабильности. */
function healthClass(score: number): string {
  if (score >= 80) return 'h-good';
  if (score >= 55) return 'h-ok';
  if (score >= 35) return 'h-mid';
  return 'h-low';
}

export const TorrentCard: React.FC<TorrentCardProps> = ({ release, onPlay, index = 0 }) => {
  const tags = parseTorrentTags(release.title);
  const meta = parseTorrentMeta(release.title);
  const [focused, setFocused] = useState(false);

  const quality = normalizeQuality(tags.quality, release.quality);
  const platform = platformClass(release.source);

  // Аудио: дорожки из названия (Atmos, 5.1) + кодек из метаданных раздачи
  const audioTags = [
    ...tags.audio,
    ...(release.audioCodec && release.audioCodec !== 'Unknown' ? [release.audioCodec] : []),
  ];
  const hasLanguageRow = audioTags.length + tags.dubbing.length + tags.subtitles.length > 0;

  const bitrate = tags.bitrateMbps ?? release.requiredMbps;
  const health = Number.isFinite(release.stabilityScore) ? release.stabilityScore : 0;

  const sizeStr = formatSize(release.sizeBytes);
  const sizeSplit = sizeStr.indexOf(' ');
  const sizeNum = sizeSplit > -1 ? sizeStr.slice(0, sizeSplit) : sizeStr;
  const sizeUnit = sizeSplit > -1 ? sizeStr.slice(sizeSplit + 1) : '';

  return (
    <div
      className={`torrent-card ${platform}${focused ? ' torrent-card-focused' : ''}`}
      tabIndex={0}
      role="button"
      aria-label={`Смотреть: ${release.title}`}
      onClick={onPlay}
      onKeyDown={(e) => keyActivate(e, onPlay)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{ animation: `fadeUp 0.28s ease ${index * 0.04}s both` }}
    >
      {/* Сигнатурная рельса качества (2px, левый край) */}
      <span className="torrent-card-rail" aria-hidden="true" />

      <div className="torrent-card-body">
        {/* Оригинальное полное имя раздачи (2 строки) */}
        <div className="torrent-card-title">{release.title}</div>

        {/* Техническая спека: качество → кодек/контейнер → сезон/серии */}
        <div className="torrent-card-specs">
          <span className={`torrent-tag torrent-tag-quality ${platform}`}>{quality}</span>
          {tags.formats.map((f) => (
            <span key={f} className="torrent-tag torrent-tag-spec">{f}</span>
          ))}
          {meta.seasons != null && (
            <span className="torrent-tag torrent-tag-spec" title={meta.seasons > 0 ? `${meta.seasons} сезон` : undefined}>
              {meta.seasons > 0 ? `S${String(meta.seasons).padStart(2, '0')}` : 'Сериал'}
            </span>
          )}
          {meta.episodes != null && meta.episodes > 0 && (
            <span className="torrent-tag torrent-tag-spec">
              {meta.seasons != null ? `${meta.episodes} серий` : `E${meta.episodes}`}
            </span>
          )}
        </div>

        {/* Аудио и языки: дорожки → озвучки → субтитры */}
        {hasLanguageRow && (
          <div className="torrent-card-lang">
            {audioTags.map((a) => (
              <span key={a} className="torrent-tag torrent-tag-audio">{a}</span>
            ))}
            {tags.dubbing.map((d) => (
              <span key={d} className="torrent-tag torrent-tag-dub">{d}</span>
            ))}
            {tags.subtitles.map((s) => (
              <span key={s} className="torrent-tag torrent-tag-sub">{s}</span>
            ))}
          </div>
        )}

        {/* Футер: слева год + трекер + здоровье, справа битрейт / сиды / пиры / размер */}
        <footer className="torrent-card-footer">
          <div className="torrent-card-meta-left">
            {tags.year && <span className="tc-year">{tags.year}</span>}
            <span className="torrent-card-tracker">{sanitizeTrackerName(release.source)}</span>
            <span
              className={`tc-health ${healthClass(health)}`}
              title={`Индекс стабильности: ${health}%`}
            >
              <span className="tc-health-dot" aria-hidden="true" />
              {release.stabilityLabel || '—'}
            </span>
          </div>
          <div className="torrent-card-meta-right">
            {bitrate != null && (
              <span className="tc-stat" title="Битрейт">
                <Activity size={12} className="tc-stat-icon" aria-hidden="true" />
                ~{bitrate} Мбит/с
              </span>
            )}
            <span className="tc-stat tc-seeders" title="Раздают">
              <ArrowUp size={12} className="tc-stat-icon" aria-hidden="true" />
              {release.seeders}
            </span>
            <span className="tc-stat tc-leechers" title="Качают">
              <ArrowDown size={12} className="tc-stat-icon" aria-hidden="true" />
              {release.leechers}
            </span>
            <span className="torrent-card-size" title={`Размер: ${release.size}`}>
              <b>{sizeNum}</b>
              {sizeUnit && <small>{sizeUnit}</small>}
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
};
