/**
 * tv.ts — Android TV: детекция TV-режима (пульт, D-pad) и обработка Back.
 *
 * Детекция TV-режима (приоритет):
 *   1) window.LUMINARY_TV === true — флаг установит нативный TV-шелл
 *      (Capacitor TV-flavor) до монтирования приложения;
 *   2) localStorage «luminary_tv_mode» — тумблер в настройках (тест на десктопе);
 *   3) UA-сниффинг Android TV / Chromecast / Fire TV / телевизоров.
 *
 * Кнопка Back: Android TV WebView шлёт Escape (keydown), нативный шелл может
 * дополнительно слать DOM-событие «backbutton». Все «слои» UI (модалки, плеер)
 * регистрируют свои обработчики в стеке (registerBackHandler) — Back закрывает
 * верхний слой, как лестницу состояний.
 */

declare global {
  interface Window {
    /** Устанавливается нативным TV-шеллом (Capacitor TV-flavor) до запуска приложения. */
    LUMINARY_TV?: boolean;
  }
}

const TV_STORAGE_KEY = 'luminary_tv_mode';

/** Маркеры TV-платформ в User-Agent. */
const TV_UA_RE =
  /Android\s+TV|CrKey|AFT[BMS]|Leanback|com\.google\.android\.tv|BRAVIA|SMART-TV|PhilipsTV|Tizen|Web0S|AppleTV|Xbox/i;

/** Эффективный TV-режим: флаг шелла > localStorage-тумблер > UA. */
export function isTvMode(): boolean {
  try {
    if (window.LUMINARY_TV === true) return true;
    const stored = localStorage.getItem(TV_STORAGE_KEY);
    if (stored !== null) return stored === '1' || stored === 'true';
  } catch { /* localStorage недоступен — fallback на UA */ }
  return TV_UA_RE.test(navigator.userAgent || '');
}

/** Значение тумблера в настройках (без UA-фолбэка) — для UI. */
export function getTvModeSetting(): boolean {
  try {
    const stored = localStorage.getItem(TV_STORAGE_KEY);
    if (stored !== null) return stored === '1' || stored === 'true';
  } catch { /* ignore */ }
  return false;
}

/** Сохранить тумблер (тумблер в настройках) + применить класс. */
export function setTvMode(enabled: boolean): void {
  try {
    localStorage.setItem(TV_STORAGE_KEY, enabled ? '1' : '0');
  } catch { /* ignore */ }
  applyTvModeClass(enabled);
}

/** Применить класс tv-mode к корню документа (CSS-оверрайды под пульт). */
export function applyTvModeClass(enabled: boolean): void {
  document.documentElement.classList.toggle('tv-mode', enabled);
}

// ── Back-стек: слои регистрируют свои обработчики, Back закрывает верхний ──
type BackHandler = () => boolean; // вернуть true — событие обработано

const backStack: BackHandler[] = [];

/** Зарегистрировать слой, который обрабатывает Back (модалка/плеер). Возвращает off. */
export function registerBackHandler(handler: BackHandler): () => void {
  backStack.push(handler);
  return () => {
    const i = backStack.indexOf(handler);
    if (i >= 0) backStack.splice(i, 1);
  };
}

/** Пройти по стеку сверху вниз; true — кто-то обработал. */
export function dispatchBack(): boolean {
  for (let i = backStack.length - 1; i >= 0; i--) {
    try {
      if (backStack[i]()) return true;
    } catch (err) {
      console.warn('[tv] Back handler error:', err);
    }
  }
  return false;
}

/** Прослушивать аппаратную Back (Escape/Backspace) + DOM-событие backbutton. */
export function addBackListener(callback: () => void): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    // Escape срабатывает всегда (даже в текстовых полях): пульт Back / очистка поиска
    if (e.key === 'Escape') {
      e.preventDefault();
      callback();
      return;
    }
    // Backspace — Back только вне текстовых полей (в поле это удаление символа)
    if (e.key !== 'Backspace') return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    e.preventDefault();
    callback();
  };
  const onBackButton = () => callback();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('backbutton', onBackButton);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('backbutton', onBackButton);
  };
}
