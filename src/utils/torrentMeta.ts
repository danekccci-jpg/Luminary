/**
 * Парсинг метаданных названий торрентов (Lampa-style):
 * озвучки, качество, серии/сезоны, аудиодорожки + приоритет русской озвучки.
 */

// Студии русской озвучки (флагманские — выше в сортировке)
const RU_STUDIOS = [
  'Дубляж',
  'HDRezka',
  'LostFilm',
  'RHS',
  'Пифагор',
  'Кубик в Кубе',
  'TVShows',
  'NewStudio',
  'Jaskier',
  'Ozz',
  'Кириллица',
  'Flarrow Films',
  'Сыендук',
  'BaibaKo',
  'Coldfilm',
  'ViruseProject',
  'LakeFilms',
  'Amazing Dubbing',
  'Оригинал + Субтитры',
  'Оригинал',
  'Субтитры',
] as const;

// Отдельные студии, которые НЕ считаются русской озвучкой как таковой
const NON_RU_STUDIOS = ['Оригинал', 'Субтитры', 'Оригинал + Субтитры'];

// Ключевые слова русской озвучки (без имени студии)
const RU_HINTS = [
  /\bru\b/i, /\brus\b/i, /\brussian\b/i,
  /русск/i, /русский/i, /русская/i, /русские/i,
  /дубляж/i, /многоголос/i, /профессиональн/i, /закадров/i,
];

export interface TorrentMeta {
  quality: string;         // 4K / 1080p / 720p / SD
  dubbings: string[];      // найденные озвучки/студии
  isRussian: boolean;      // есть русская озвучка
  seasons: number | null;  // сезон (S01 / «1 сезон»)
  episodes: number | null; // серии (E01 / «12 серий» / E01-E12)
  audioTracks: string[];   // AC3, EAC3, DTS, TrueHD, AAC, MP3…
  studioScore: number;     // очки за флагманские студии
}

export function parseTorrentMeta(title: string): TorrentMeta {
  const t = title || '';
  const lower = t.toLowerCase();

  const dubbings: string[] = [];
  for (const st of RU_STUDIOS) {
    if (lower.includes(st.toLowerCase())) dubbings.push(st);
  }
  // «Оригинал + Субтитры» уже покрывает «Оригинал» и «Субтитры» — не дублируем бейджи
  if (dubbings.includes('Оригинал + Субтитры')) {
    const i1 = dubbings.indexOf('Оригинал');
    if (i1 > -1) dubbings.splice(i1, 1);
    const i2 = dubbings.indexOf('Субтитры');
    if (i2 > -1) dubbings.splice(i2, 1);
  }

  // Качество
  let quality = 'SD';
  if (/2160p|4k|uhd|ultra ?hd/i.test(t)) quality = '4K';
  else if (/1080p|full ?hd|fhd/i.test(t)) quality = '1080p';
  else if (/720p|hdrip|hdtv/i.test(t)) quality = '720p';

  // Серии / сезоны (S01E01-E12, «сезон 1», «1 сезон», «12 серий»)
  let seasons: number | null = null;
  let episodes: number | null = null;
  const sMatch =
    t.match(/s(\d{1,2})\s*e\d{1,3}/i) ||
    t.match(/s(\d{1,2})(?:\s*[-–]\s*\d{1,2})?/i) ||
    t.match(/сезон\s*(\d{1,2})/i) ||
    t.match(/(\d{1,2})\s*сезон/i);
  const eMatch =
    t.match(/e(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/i) ||
    t.match(/(\d{1,3})\s*сери[ияй]/i) ||
    t.match(/сери[ияй]\s*(\d{1,3})/i);
  if (sMatch) seasons = parseInt(sMatch[1], 10);
  if (eMatch) episodes = parseInt(eMatch[1], 10);

  // Аудиодорожки
  const audioTracks: string[] = [];
  for (const codec of ['TrueHD', 'Atmos', 'DTS', 'EAC3', 'AC3', 'AAC', 'MP3', 'FLAC', 'PCM']) {
    if (new RegExp(codec, 'i').test(t)) audioTracks.push(codec.toUpperCase());
  }

  // Русская озвучка + очки студий
  const ruStudios = dubbings.filter((d) => !NON_RU_STUDIOS.includes(d));
  const isRussian = ruStudios.length > 0 || RU_HINTS.some((re) => re.test(lower));
  const studioScore = dubbings.reduce((acc, d) => {
    if (d === 'Дубляж') return acc + 10;
    if (['HDRezka', 'LostFilm', 'RHS', 'Пифагор', 'Кубик в Кубе'].includes(d)) return acc + 8;
    return acc + 5;
  }, 0);

  return { quality, dubbings, isRussian, seasons, episodes, audioTracks, studioScore };
}

/**
 * Приоритет для сортировки «RU + Сиды»: русская озвучка и флагманские студии
 * поднимаются выше англоязычных источников (Torrentio и т.п.).
 */
export function russianPriority(r: { title?: string; dubbing?: string }): number {
  const meta = parseTorrentMeta(r.title || '');
  let score = 0;
  if (meta.isRussian) score += 50;
  score += meta.studioScore;
  const d = r.dubbing || '';
  if (/Дубляж|RHS|HDRezka|LostFilm/i.test(d)) score += 40;
  else if (/Оригинал|EN\b|English|Torrentio/i.test(d)) score -= 25;
  return score;
}
