import { create } from 'zustand';
import { clearApiKey, readApiKey, writeApiKey, type VenueSession } from './api';

export type Section = 'stats' | 'settings' | 'pairing' | 'players' | 'picks' | 'devices';

export interface Toast {
  id: number;
  message: string;
  tone: 'ok' | 'error';
}

interface AdminState {
  session: VenueSession | null;
  /** True while a stored key is being checked on boot. */
  restoring: boolean;
  section: Section;
  toasts: Toast[];

  signIn: (key: string, session: VenueSession) => void;
  signOut: () => void;
  setSession: (session: VenueSession) => void;
  setRestoring: (restoring: boolean) => void;
  setSection: (section: Section) => void;
  pushToast: (message: string, tone: Toast['tone']) => void;
  dismissToast: (id: number) => void;
}

let toastId = 0;

export const useAdminStore = create<AdminState>((set) => ({
  // A key already in sessionStorage means a reload should not force a re-login;
  // it is verified against the API before the console renders.
  session: null,
  restoring: readApiKey() !== null,
  section: 'stats',
  toasts: [],

  signIn: (key, session) => {
    writeApiKey(key);
    set({ session, restoring: false, section: 'stats' });
  },

  signOut: () => {
    clearApiKey();
    set({ session: null, restoring: false, toasts: [] });
  },

  setSession: (session) => {
    set({ session });
  },

  setRestoring: (restoring) => {
    set({ restoring });
  },

  setSection: (section) => {
    set({ section });
  },

  pushToast: (message, tone) => {
    toastId += 1;
    const toast: Toast = { id: toastId, message, tone };
    set((state) => ({ toasts: [...state.toasts, toast] }));
  },

  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },
}));
