/**
 * Санитайзер имён трекеров для бейджей раздач.
 * Приводит «сырые» source-строки скраперов к чистым отображаемым именам:
 *   "Rutor Tracker"   → "Rutor"
 *   "RuTracker.org"   → "RuTracker"
 *   "NNM-Club"        → "NNM-Club"
 *   "Torrentio"       → "Torrentio"
 *   "Jackett"         → "Jackett"
 *   "JacRed · Rutor"  → "Rutor" (берём часть после «·»)
 */
export function sanitizeTrackerName(source: string | null | undefined): string {
  let s = String(source || '').trim();
  if (!s) return '—';

  // JacRed-раздачи приходят как «JacRed · <трекер>» — показываем трекер
  if (s.includes('·')) {
    const after = s.split('·').pop()?.trim() || '';
    if (after) s = after;
  }

  if (/rutracker/i.test(s)) return 'RuTracker';
  if (/nnm/i.test(s)) return 'NNM-Club';
  if (/rutor/i.test(s)) return 'Rutor';
  if (/torrentio/i.test(s)) return 'Torrentio';
  if (/jackett/i.test(s)) return 'Jackett';
  if (/jacred/i.test(s)) return 'JacRed';
  if (/kinozal/i.test(s)) return 'Kinozal';
  if (/megapeer/i.test(s)) return 'Megapeer';
  if (/cinemaz/i.test(s)) return 'CinemaZ';

  return s;
}
