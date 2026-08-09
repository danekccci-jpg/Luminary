/**
 * jacredServer.ts — рендер-обёртка над встроенным локальным JacRed (Zero-Config).
 *
 * Main Process скачивает бинарник jacred (при первом запуске), spawn'ит его
 * на 127.0.0.1:9117 и держит как дочерний процесс (как TorrServer). Этот модуль:
 *  1. Прокидывает IPC (статус / запуск / остановка / веб-интерфейс);
 *  2. Автоматически регистрирует локальный инстанс первым в пуле JacRed
 *     (setLocalJacredUrl) — поиск RuTracker/NNM/Rutor идёт через него.
 *
 * Первый запуск может занять время (скачивание ~46 МБ + распаковка) —
 * поэтому initLocalJacred() использует retry-цикл, а не один запрос.
 */

import { setLocalJacredUrl } from './scrapers/jacred';

/** Локальный URL встроенного JacRed (порт фиксирован в Main Process). */
const LOCAL_JACRED_PORT = 9117;
export const LOCAL_JACRED_URL = `http://127.0.0.1:${LOCAL_JACRED_PORT}`;

export interface JacredServerStatus {
  running: boolean;
  starting?: boolean;
  port: number;
  error?: string;
}

/** Подключить локальный инстанс к пулу (или отключить при остановке). */
function syncPoolWithStatus(st: JacredServerStatus | null) {
  if (st && st.running) {
    setLocalJacredUrl(LOCAL_JACRED_URL);
  } else {
    setLocalJacredUrl('');
  }
}

/** Текущий статус встроенного JacRed (+ синхронизация пула). */
export async function getJacredServerStatus(): Promise<JacredServerStatus> {
  const st: JacredServerStatus =
    (await window.electronAPI?.getJacredStatus?.()) ?? {
      running: false,
      starting: false,
      port: LOCAL_JACRED_PORT,
    };
  syncPoolWithStatus(st);
  return st;
}

/** Запустить локальный JacRed (скачивание бинарника при первом старте). */
export async function startJacredServer(): Promise<JacredServerStatus> {
  const st =
    (await window.electronAPI?.startJacredServer?.()) ?? { running: false, port: LOCAL_JACRED_PORT };
  syncPoolWithStatus(st);
  return st;
}

/** Остановить локальный JacRed. */
export async function stopJacredServer(): Promise<{ running: boolean; port: number }> {
  const st = (await window.electronAPI?.stopJacredServer?.()) ?? { running: false, port: LOCAL_JACRED_PORT };
  syncPoolWithStatus({ running: st.running, port: st.port });
  return st;
}

/** Открыть веб-интерфейс JacRed (http://127.0.0.1:9117) в системном браузере. */
export async function openJacredUi(): Promise<boolean> {
  const res = (await window.electronAPI?.openJacredUi?.()) ?? { success: false };
  return !!res.success;
}

export interface JacredAuthStatus {
  rutracker: boolean;
  nnmClub: boolean;
}

/** Авторизация приватных трекеров (RuTracker / NNM-Club) в локальном JacRed. */
export async function getJacredAuthStatus(): Promise<JacredAuthStatus> {
  return (
    (await window.electronAPI?.getJacredAuthStatus?.()) ?? { rutracker: false, nnmClub: false }
  );
}

export interface JacredLoginResult {
  success: boolean;
  auth?: JacredAuthStatus;
  error?: string;
}

/** Сохранить креды приватного трекера в конфиг JacRed + разгон парсера. */
export async function jacredLoginTracker(
  tracker: 'rutracker' | 'nnmclub',
  creds: { username?: string; password?: string; cookie?: string }
): Promise<JacredLoginResult> {
  return (
    (await window.electronAPI?.jacredLogin?.(tracker, creds)) ?? {
      success: false,
      error: 'IPC недоступен',
    }
  );
}

/** Есть ли доступ к локальному JacRed (IPC присутствует в preload). */
export function hasLocalJacredSupport(): boolean {
  return !!window.electronAPI?.getJacredStatus;
}

// ── Авто-подключение на старте приложения (с retry) ──

/**
 * Дождаться запуска встроенного JacRed и зарегистрировать его в пуле.
 * Main Process стартует сервер в фоне и сам перезапускается при сбое —
 * здесь мы лишь опрашиваем статус, пока не увидим running.
 * Возвращает true, если инстанс доступен (использовался в поиске).
 */
export async function initLocalJacred(maxAttempts = 30, intervalMs = 2000): Promise<boolean> {
  if (!hasLocalJacredSupport()) return false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const st = await getJacredServerStatus();
      if (st.running) {
        console.log(`[JacRed] Локальный инстанс онлайн — ${LOCAL_JACRED_URL} (попытка ${attempt})`);
        return true;
      }
    } catch { /* сервис ещё стартует — продолжаем опрос */ }
    // Пауза между попытками (первый запуск = скачивание ~46 МБ бинарника)
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.warn('[JacRed] Локальный инстанс не поднялся за отведённое время — публичные зеркала');
  return false;
}
