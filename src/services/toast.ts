/**
 * Minimal global toast bus — no context/providers needed.
 * Components push notifications; <Toaster/> (mounted once in App) renders them.
 */
export type ToastType = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  const snapshot = [...toasts];
  listeners.forEach((l) => l(snapshot));
}

export const toastBus = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  push(message: string, type: ToastType = 'info', duration = 4500): number {
    const id = nextId++;
    toasts = [...toasts, { id, message, type }];
    emit();
    window.setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
      emit();
    }, duration);
    return id;
  },
  dismiss(id: number) {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  },
  clear() {
    toasts = [];
    emit();
  },
};
