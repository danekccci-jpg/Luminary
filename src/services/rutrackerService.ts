/**
 * rutrackerService.ts — браузерный сеанс RuTracker (main-процесс):
 * окно входа в приложении (проходит Cloudflare) + поиск через window.fetch.
 * Магнеты реальных раздач появляются ТОЛЬКО после входа (bb_session).
 */

export interface RutrackerStatus {
  loggedIn: boolean;
  loginWindowOpen: boolean;
  error?: string;
}

export async function getRutrackerStatus(): Promise<RutrackerStatus> {
  return (
    (await window.electronAPI?.rutrackerGetStatus?.()) ?? {
      loggedIn: false,
      loginWindowOpen: false,
    }
  );
}

/** Открыть видимое окно входа RuTracker внутри приложения (как сайт). */
export async function openRutrackerLogin(): Promise<RutrackerStatus> {
  return (
    (await window.electronAPI?.rutrackerOpenLogin?.()) ?? {
      loggedIn: false,
      loginWindowOpen: false,
      error: 'IPC недоступен',
    }
  );
}

/** Скрыть окно входа (сессия сохраняется). */
export async function hideRutrackerLogin(): Promise<boolean> {
  const res = (await window.electronAPI?.rutrackerHideLogin?.()) ?? { ok: false };
  return !!res.ok;
}

/** Подписка на смену состояния входа (bb_session появился/пропал). */
export function onRutrackerStatusChanged(cb: (st: { loggedIn: boolean }) => void): () => void {
  return window.electronAPI?.onRutrackerStatusChanged?.(cb) ?? (() => {});
}
