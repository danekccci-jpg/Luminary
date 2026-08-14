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
  'Гоблин',
  'Переозвучка',
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
  /гоблин/i, /переозвучк/i,
];

export interface TorrentMeta {
  quality: string;         // 4K / 1080p / 720p / SD
  dubbings: string[];      // найденные озвучки/студии
  isRussian: boolean;      // есть русская озвучка
  seasons: number | null;  // сезон (S01 / «1 сезон»)
  seasonsTo: number | null; // конец диапазона (S01-S03 → seasonsTo=3)
  episodes: number | null; // серии (E01 / «12 серий» / E01-E12)
  audioTracks: string[];   // AC3, EAC3, DTS, TrueHD, AAC, MP3…
  studioScore: number;     // очки за флагманские студии
  /** Год версии озвучки, извлечённый из контекста («Гоблин 2020»). */
  dubbingYear?: string;
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

  // Год версии озвучки: «Гоблин 2020», «Переозвучка 2024», «Дубляж 2019»
  let dubbingYear: string | undefined;
  const yearMatch = t.match(/(дубляж|гоблин|переозвучк|lost\s?film|hdrezka|rhs)\s+(\d{4})/i);
  if (yearMatch) dubbingYear = yearMatch[2];

  // Качество
  let quality = 'SD';
  if (/2160p|4k|uhd|ultra ?hd/i.test(t)) quality = '4K';
  else if (/1080p|full ?hd|fhd/i.test(t)) quality = '1080p';
  else if (/720p|hdrip|hdtv/i.test(t)) quality = '720p';

  // Серии / сезоны (S01E01-E12, S01-S03, «сезон 1», «1 сезон», «12 серий»)
  let seasons: number | null = null;
  let seasonsTo: number | null = null;
  let episodes: number | null = null;

  // 1) S01E01-E12 → seasons=1, episodes=1-12
  const sxeMatch = t.match(/s(\d{1,2})\s*e(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/i);
  if (sxeMatch) {
    seasons = parseInt(sxeMatch[1], 10);
    episodes = parseInt(sxeMatch[2], 10);
    if (sxeMatch[3]) episodes = parseInt(sxeMatch[3], 10); // берём конец диапазона серий
  }
  // 2) S01-S03 (сезон-пак без серий) → seasons=1, seasonsTo=3
  if (seasons === null) {
    const rangeMatch = t.match(/s(\d{1,2})\s*[-–—]\s*s?(\d{1,2})/i);
    if (rangeMatch) {
      seasons = Math.min(parseInt(rangeMatch[1], 10), parseInt(rangeMatch[2], 10));
      seasonsTo = Math.max(parseInt(rangeMatch[1], 10), parseInt(rangeMatch[2], 10));
    }
  }
  // 3) S01 (одиночный сезон)
  if (seasons === null) {
    const sOnlyMatch = t.match(/\bs(\d{1,2})\b/i);
    if (sOnlyMatch) seasons = parseInt(sOnlyMatch[1], 10);
  }
  // 4) Русские: «сезон 1», «1 сезон», «12 серий»
  if (seasons === null) {
    const ruSeasonMatch = t.match(/сезон\s*(\d{1,2})/i) || t.match(/(\d{1,2})\s*сезон/i);
    if (ruSeasonMatch) seasons = parseInt(ruSeasonMatch[1], 10);
  }
  if (episodes === null) {
    const ruEpMatch = t.match(/(\d{1,3})\s*сери[ияй]/i) || t.match(/сери[ияй]\s*(\d{1,3})/i);
    if (ruEpMatch) episodes = parseInt(ruEpMatch[1], 10);
  }

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
    if (['HDRezka', 'LostFilm', 'RHS', 'Пифагор', 'Кубик в Кубе', 'Гоблин'].includes(d)) return acc + 8;
    return acc + 5;
  }, 0);

  return { quality, dubbings, isRussian, seasons, seasonsTo, episodes, audioTracks, studioScore, dubbingYear };
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
  if (/Дубляж|RHS|HDRezka|LostFilm|Гоблин/i.test(d)) score += 40;
  else if (/Оригинал|EN\b|English|Torrentio/i.test(d)) score -= 25;
  return score;
}
