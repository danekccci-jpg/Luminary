/**
 * focus.ts — фокус-менеджмент для клавиатурной / пультовой (D-pad) навигации.
 *
 * Android TV WebView умеет spatial navigation: пульт двигает фокус между
 * фокусируемыми элементами. Наша задача — сделать элементы фокусируемыми
 * (tabindex/role/onKeyDown) и НЕ перехватывать стрелки вне плеера.
 */
import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

/** Селектор «живых» фокусируемых элементов. */
export const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
].join(', ');

/** Фокус на первый фокусируемый элемент внутри container. */
export function focusFirstIn(container: HTMLElement | null): boolean {
  if (!container) return false;
  const el = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
  if (el) {
    el.focus({ preventScroll: true });
    return true;
  }
  return false;
}

/** Фокус на первую карточку фильма (или первый фокусируемый элемент). */
export function focusFirstCard(container: HTMLElement | null): boolean {
  if (!container) return false;
  const card = container.querySelector<HTMLElement>('.movie-card');
  if (card) {
    card.focus({ preventScroll: true });
    return true;
  }
  return focusFirstIn(container);
}

/**
 * Лёгкий focus trap для модалок: при active=true фокус входит в контейнер
 * и Tab не покидает его (стрелки/D-pad на TV держит сам WebView — фоновые
 * элементы под оверлеем пространственно дальше).
 */
export function useFocusTrap(active: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!active || !ref.current) return;
    if (!ref.current.contains(document.activeElement)) {
      focusFirstIn(ref.current);
    }
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const container = ref.current;
      if (!container || !container.contains(document.activeElement)) return;
      const els = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (!activeEl) return;
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [active, ref]);
}

/** onKeyDown для элементов-«кнопок» (div/li): Enter и Space активируют. */
export function keyActivate(event: ReactKeyboardEvent, action: () => void): void {
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault();
    action();
  }
}
