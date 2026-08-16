/**
 * timeline.ts — хронология франшиз для секции «По хронологии».
 *
 * TMDB-коллекции покрывают только одну франшизу (например, «Человек-паук»
 * или «Мстители»), но НЕ кросс-франшизные хронологии вроде MCU, где после
 * «Человека-паука: Возвращение домой» идёт «Мстители: Война бесконечности».
 * Для MCU — курируемый датасет по TMDB id (порядок по сюжету); для остальных
 * фильмов — TMDB-коллекция (parts), отсортированная по дате релиза.
 */

import { Movie } from '../types';
import { tmdbService } from './tmdb';

export interface TimelineResult {
  /** Название серии/франшизы для шапки секции. */
  seriesName: string;
  /** Предыдущая часть по хронологии (карточка для клика). */
  prev?: Movie;
  /** Следующая часть по хронологии. */
  next?: Movie;
}

const MCU_PHASE = 'Киновселенная Marvel';

/**
 * Курируемый порядок MCU (по сюжету). Ключ — числовой TMDB id.
 * «Возвращение домой» → «Война бесконечности» → «Финал» → «Вдали от дома»
 * → «Нет пути домой» идут подряд — после «Возвращения домой» ожидаемо
 * «Мстители», а не сиквел Спайди.
 */
const MCU_TIMELINE: Array<{ tmdbId: number; order: number }> = [
  { tmdbId: 1771, order: 1 },   // Капитан Америка: Первый мститель
  { tmdbId: 299537, order: 2 }, // Капитан Марвел
  { tmdbId: 1726, order: 3 },   // Железный человек
  { tmdbId: 10138, order: 4 },  // Железный человек 2
  { tmdbId: 1724, order: 5 },   // Невероятный Халк
  { tmdbId: 10195, order: 6 },  // Тор
  { tmdbId: 24428, order: 7 },  // Мстители
  { tmdbId: 68721, order: 8 },  // Железный человек 3
  { tmdbId: 76338, order: 9 },  // Тор 2: Царство тьмы
  { tmdbId: 100402, order: 10 },// Первый мститель: Другая война
  { tmdbId: 118340, order: 11 },// Стражи Галактики
  { tmdbId: 283995, order: 12 },// Стражи Галактики. Часть 2
  { tmdbId: 99861, order: 13 }, // Мстители: Эра Альтрона
  { tmdbId: 102899, order: 14 },// Человек-муравей
  { tmdbId: 271110, order: 15 },// Первый мститель: Противостояние
  { tmdbId: 497698, order: 16 },// Чёрная вдова
  { tmdbId: 284054, order: 17 },// Чёрная пантера
  { tmdbId: 284052, order: 18 },// Доктор Стрэндж
  { tmdbId: 284053, order: 19 },// Тор: Рагнарёк
  { tmdbId: 363088, order: 20 },// Человек-муравей и Оса
  { tmdbId: 315635, order: 21 },// Человек-паук: Возвращение домой
  { tmdbId: 299536, order: 22 },// Мстители: Война бесконечности
  { tmdbId: 299534, order: 23 },// Мстители: Финал
  { tmdbId: 429617, order: 24 },// Человек-паук: Вдали от дома
  { tmdbId: 634649, order: 25 },// Человек-паук: Нет пути домой
  { tmdbId: 566525, order: 26 },// Шан-Чи и легенда десяти колец
  { tmdbId: 524434, order: 27 },// Вечные
  { tmdbId: 453395, order: 28 },// Доктор Стрэндж: В мультивселенной безумия
  { tmdbId: 616037, order: 29 },// Тор: Любовь и гром
  { tmdbId: 505642, order: 30 },// Чёрная пантера: Ваканда навсегда
  { tmdbId: 640146, order: 31 },// Человек-муравей и Оса: Квантомания
  { tmdbId: 447365, order: 32 },// Стражи Галактики. Часть 3
  { tmdbId: 609681, order: 33 },// Капитан Марвел 2
];

const MCU_ORDER = new Map(MCU_TIMELINE.map((e) => [e.tmdbId, e]));

/** Соседи по курируемому MCU-датасету (prev/next по порядковому номеру). */
function mcuNeighbors(tmdbId: number): { prevId?: number; nextId?: number } {
  const entry = MCU_ORDER.get(tmdbId);
  if (!entry) return {};
  const prev = MCU_TIMELINE[entry.order - 2]; // order с 1 → индекс order-1
  const next = MCU_TIMELINE[entry.order];     // следующий — индекс order
  return { prevId: prev?.tmdbId, nextId: next?.tmdbId };
}

/**
 * Хронология для фильма: сначала MCU-датасет (кросс-франшизный порядок),
 * иначе TMDB-коллекция. Возвращает соседние части или null (фильм вне серии).
 */
export async function getTimelineForMovie(
  movieId: number | string,
  belongsToCollection: Movie['belongs_to_collection']
): Promise<TimelineResult | null> {
  const tmdbId = typeof movieId === 'number' ? movieId : Number(movieId);
  if (!Number.isFinite(tmdbId)) return null;

  // 1) MCU — курируемая хронология (TMDB-коллекции тут бессильны)
  const neighbors = mcuNeighbors(tmdbId);
  if (neighbors.prevId || neighbors.nextId) {
    const [prev, next] = await Promise.all([
      neighbors.prevId ? tmdbService.getMovieBrief(neighbors.prevId) : Promise.resolve(null),
      neighbors.nextId ? tmdbService.getMovieBrief(neighbors.nextId) : Promise.resolve(null),
    ]);
    return {
      seriesName: MCU_PHASE,
      prev: prev || undefined,
      next: next || undefined,
    };
  }

  // 2) Обычная франшиза: TMDB-коллекция, parts по дате релиза
  if (!belongsToCollection?.id) return null;
  const parts = await tmdbService.getCollection(belongsToCollection.id);
  const idx = parts.findIndex((p) => Number(p.id) === tmdbId);
  if (idx === -1 || parts.length < 2) return null;
  return {
    seriesName: belongsToCollection.name,
    prev: idx > 0 ? parts[idx - 1] : undefined,
    next: idx < parts.length - 1 ? parts[idx + 1] : undefined,
  };
}
