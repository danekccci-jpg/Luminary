/**
 * Строгая валидация года из даты TMDB / сторонних парсеров.
 * Извлекает первые 4 цифры (YYYY) и проверяет реалистичный диапазон
 * 1900..текущий год. Никогда не подставляет текущий системный год.
 */
export function extractYear(value?: string | number | null): string {
  if (value === undefined || value === null || value === '') return '';
  const str = String(value).trim();
  const m = str.match(/^(\d{4})/);
  if (!m) return '';
  const year = parseInt(m[1], 10);
  const current = new Date().getFullYear();
  if (year >= 1900 && year <= current) return String(year);
  return '';
}

/** Проверить, является ли строка валидным годом (для фоллбеков парсеров). */
export function isValidYear(value?: string | number | null): boolean {
  return extractYear(value) !== '';
}
