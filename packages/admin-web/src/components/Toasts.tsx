import { useEffect } from 'react';
import { useAdminStore } from '../lib/store';

const DISMISS_AFTER_MS = 5_000;

export function Toasts() {
  const toasts = useAdminStore((state) => state.toasts);
  const dismissToast = useAdminStore((state) => state.dismissToast);

  useEffect(() => {
    if (toasts.length === 0) {
      return;
    }
    const timers = toasts.map((toast) =>
      setTimeout(() => {
        dismissToast(toast.id);
      }, DISMISS_AFTER_MS),
    );
    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [toasts, dismissToast]);

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`}>
          <span>{toast.message}</span>
          <button
            type="button"
            className="toast__close"
            aria-label="Dismiss"
            onClick={() => {
              dismissToast(toast.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
