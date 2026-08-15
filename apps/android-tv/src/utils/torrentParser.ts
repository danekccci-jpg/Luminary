/**
 * torrentParser.ts — извлечение тегов из СЫРОГО названия раздачи (Lampa-style).
 * Возвращает структурированные бейджи для карточки раздачи:
 * качество, форматы, аудио, озвучки, субтитры, год, битрейт.
 */

export interface TorrentTags {
  /** Разрешение: 4K (2160p) / FHD (1080p) / HD (720p) / SD. */
  quality: '4K' | 'FHD' | 'HD' | 'SD';
  /** Форматы: HDR, HDR10+, DV, HEVC, H.264, BDRip, WEB-DL. */
  formats: string[];
  /** Аудио: Atmos, 5.1, 7.1, 2.0. */
  audio: string[];
  /** Озвучки/студии: Дубляж, RHS, HDRezka, LostFilm, Сектор, LeDoyen, Eng, Rus. */
  dubbing: string[];
  /** Субтитры: Sub, Rus Sub, Eng Sub. */
  subtitles: string[];
  /** Год релиза из названия (2021, 1998…). */
  year?: string;
  /** Битрейт из названия («~25 Mbps») — если указан. */
  bitrateMbps?: number;
}

export function parseTorrentTags(title: string): TorrentTags {
  const t = title || '';
  const lower = t.toLowerCase();

  // ── Качество: 4K (2160p) → FHD (1080p) → HD (720p) → SD ──
  let quality: TorrentTags['quality'] = 'SD';
  if (/\b(2160p|4k)\b|4k\s*uhd|\buhd\b|ultra\s*hd/.test(lower)) quality = '4K';
  else if (/\b1080p\b|\bfhd\b|full\s*hd/.test(lower)) quality = 'FHD';
  else if (/\b720p\b|\bhd\b|\bhdtv\b|\bhdrip\b/.test(lower)) quality = 'HD';

  // ── Форматы (порядок проверки важен: HDR10+ раньше HDR) ──
  const formats: string[] = [];
  if (/\bhdr10\+/.test(lower)) formats.push('HDR10+');
  else if (/\bhdr\b|\bhdr10\b/.test(lower)) formats.push('HDR');
  if (/\bdolby\s*vision\b|\bdv\b/.test(lower)) formats.push('DV');
  if (/\bhevc\b|\bx265\b|h\.?265/.test(lower)) formats.push('HEVC');
  if (/\bh\.?264\b|\bx264\b|\bavc\b/.test(lower)) formats.push('H.264');
  if (/\bremux\b/.test(lower)) formats.push('REMUX');
  if (/\bbd-?rip\b|\bblu-?ray\b|\bbr-?rip\b/.test(lower)) formats.push('BDRip');
  if (/\bweb-?dl\b/.test(lower)) formats.push('WEB-DL');
  else if (/\bweb-?rip\b/.test(lower)) formats.push('WEBRip');

  // ── Аудиоканалы/форматы звука ──
  const audio: string[] = [];
  if (/\bdolby\s*atmos\b|\batmos\b/.test(lower)) audio.push('Atmos');
  if (/\b7\.1\b/.test(lower)) audio.push('7.1');
  if (/\b5\.1\b/.test(lower)) audio.push('5.1');
  if (/\b2\.0\b/.test(lower)) audio.push('2.0');

  // ── Субтитры (до озвучек — чтобы «Eng Sub» не дублировался как «Eng») ──
  const subtitles: string[] = [];
  if (/\brus(sian)?\s*sub/.test(lower)) subtitles.push('Rus Sub');
  if (/\beng\s*sub/.test(lower)) subtitles.push('Eng Sub');
  if (subtitles.length === 0 && /\bsub(s|titles?)?\b/.test(lower) && !/\bno\s*sub/.test(lower)) {
    subtitles.push('Sub');
  }

  // ── Озвучки и язык (Rus/Eng — только если это не «Rus/Eng Sub») ──
  const dubbing: string[] = [];
  if (/дубляж|двухголос|многоголос|профессиональн|закадров/i.test(t)) dubbing.push('Дубляж');
  if (/оригинал\s*\+?\s*суб/i.test(t)) dubbing.push('Оригинал + Субтитры');
  else if (/оригинал/i.test(t)) dubbing.push('Оригинал');
  if (/\brhs\b/i.test(t)) dubbing.push('RHS');
  if (/hdrezka/i.test(t)) dubbing.push('HDRezka');
  if (/lost\s?film/i.test(t)) dubbing.push('LostFilm');
  if (/tvshows|твшоу/i.test(t)) dubbing.push('TVShows');
  if (/кубик\s*в\s*кубе/i.test(t)) dubbing.push('Кубик в Кубе');
  if (/ozz|озз/i.test(t)) dubbing.push('Ozz');
  if (/new\s?studio|ню\s?студио/i.test(t)) dubbing.push('NewStudio');
  if (/пифагор/i.test(t)) dubbing.push('Пифагор');
  if (/сектор/i.test(t)) dubbing.push('Сектор');
  if (/ledoyen/i.test(t)) dubbing.push('LeDoyen');
  if (/\beng\b/i.test(t) && !/\beng\s*sub/i.test(t)) dubbing.push('Eng');
  if (/\brus(sian)?\b/i.test(t) && !/\brus(sian)?\s*sub/i.test(t)) dubbing.push('Rus');

  // ── Год релиза ──
  const yearMatch = t.match(/\b(19\d{2}|20\d{2})\b/);

  // ── Битрейт из названия («~25 Mbps», «~25 Мбит/с») ──
  let bitrateMbps: number | undefined;
  const brMatch = t.match(/(\d+(?:[.,]\d+)?)\s*(?:mbps|мбит\/?\s*с)/i);
  if (brMatch) {
    const v = parseFloat(brMatch[1].replace(',', '.'));
    if (Number.isFinite(v) && v > 0) bitrateMbps = v;
  }

  return { quality, formats, audio, dubbing, subtitles, year: yearMatch?.[1], bitrateMbps };
}
