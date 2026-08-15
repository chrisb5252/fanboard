import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { useAdminStore } from '../lib/store';

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  useAdminStore.setState({ session: null, restoring: false, section: 'stats', toasts: [] });
});
