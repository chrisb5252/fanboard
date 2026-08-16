'use client';

import { useEffect } from 'react';

export interface ToastProps {
  message: string;
  tone?: 'success' | 'error';
  onDismiss: () => void;
}

/**
 * Transient confirmation. `role="status"` rather than `alert` for success, so a
 * screen reader announces it without interrupting whatever it was reading.
 */
export function Toast({ message, tone = 'success', onDismiss }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 3200);
    return () => clearTimeout(timer);
  }, [onDismiss, message]);

  const palette =
    tone === 'success'
      ? 'bg-accent-green text-dark-900'
      : 'bg-accent-red text-white';

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`fixed inset-x-4 bottom-6 z-50 mx-auto max-w-sm rounded-lg px-4 py-3 text-center font-bold shadow-lg animate-slide-up ${palette}`}
    >
      {message}
    </div>
  );
}
