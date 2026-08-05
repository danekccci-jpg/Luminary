/**
 * Менеджер личной библиотеки на localStorage (без сторонних БД):
 * История просмотров (с таймкодом), Избранное, «Посмотреть позже».
 */

export interface LibraryItem {
  id: string;
  title: string;
  poster?: string | null;
  year?: string;
  mediaType?: 'movie' | 'tv';
  /** Прогресс просмотра (сек) */
  position?: number;
  duration?: number;
  /** Сезон/серия (для сериалов) — ключ истории по эпизодам */
  season?: number;
  episode?: number;
  /** Прогресс в процентах (0-100) — для диалога «Продолжить/Следующая серия» */
  progressPercentage?: number;
  updatedAt: number;
}

const KEYS = {
  history: 'luminary_history',
  favorites: 'luminary_favorites',
  later: 'luminary_later',
} as const;

const HISTORY_LIMIT = 50;

/** Композитный ключ записи истории: id + сезон/серия (у фильмов s/e пустые). */
function historyKey(item: Pick<LibraryItem, 'id' | 'season' | 'episode'>): string {
  return `${item.id}|s${item.season ?? ''}e${item.episode ?? ''}`;
}

function read(key: string): LibraryItem[] {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function write(key: string, items: LibraryItem[]) {
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    /* переполнение localStorage — игнорируем */
  }
}

export const library = {
  // ── История ──
  getHistory(): LibraryItem[] {
    return read(KEYS.history).sort((a, b) => b.updatedAt - a.updatedAt);
  },

  /** Сохранить/обновить прогресс просмотра. position<=0 или >=duration — не пишем.
   *  Для сериалов item.season/episode создают отдельную запись на каждую серию. */
  saveProgress(item: Omit<LibraryItem, 'updatedAt'>, position: number, duration: number) {
    if (!item.id || position < 0 || duration <= 0) return;
    const key = historyKey(item);
    const list = read(KEYS.history).filter((i) => historyKey(i) !== key);
    const pct = duration > 0 ? Math.min(100, Math.round((position / duration) * 100)) : 0;
    list.unshift({
      ...item,
      position,
      duration,
      progressPercentage: pct,
      updatedAt: Date.now(),
    });
    write(KEYS.history, list.slice(0, HISTORY_LIMIT));
  },

  /** Прогресс по id (и сезону/серии для сериалов). */
  getProgress(
    id: string,
    season?: number,
    episode?: number
  ): { position: number; duration: number; season?: number; episode?: number; progressPercentage?: number } | null {
    const key = `${id}|s${season ?? ''}e${episode ?? ''}`;
    const item = read(KEYS.history).find((i) => historyKey(i) === key);
    if (!item || !item.duration || !item.position) return null;
    // Прогресс важен, только если не досмотрено до конца
    if (item.position > 5 && item.position < item.duration - 10) {
      return {
        position: item.position,
        duration: item.duration,
        season: item.season,
        episode: item.episode,
        progressPercentage: item.progressPercentage,
      };
    }
    return null;
  },

  removeFromHistory(id: string) {
    write(KEYS.history, read(KEYS.history).filter((i) => i.id !== id));
  },

  // ── Избранное ──
  getFavorites(): LibraryItem[] {
    return read(KEYS.favorites);
  },

  isFavorite(id: string): boolean {
    return read(KEYS.favorites).some((i) => i.id === id);
  },

  toggleFavorite(item: Omit<LibraryItem, 'updatedAt'>): boolean {
    const list = read(KEYS.favorites);
    const exists = list.some((i) => i.id === item.id);
    write(KEYS.favorites, exists ? list.filter((i) => i.id !== item.id) : [{ ...item, updatedAt: Date.now() }, ...list]);
    return !exists;
  },

  // ── Посмотреть позже ──
  getLater(): LibraryItem[] {
    return read(KEYS.later);
  },

  isInLater(id: string): boolean {
    return read(KEYS.later).some((i) => i.id === id);
  },

  toggleLater(item: Omit<LibraryItem, 'updatedAt'>): boolean {
    const list = read(KEYS.later);
    const exists = list.some((i) => i.id === item.id);
    write(KEYS.later, exists ? list.filter((i) => i.id !== item.id) : [{ ...item, updatedAt: Date.now() }, ...list]);
    return !exists;
  },
};

/** Формат таймкода HH:MM:SS для кнопки «Продолжить с». */
export function formatClock(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '00:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}
