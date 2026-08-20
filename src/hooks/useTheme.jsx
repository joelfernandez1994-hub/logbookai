import { createContext, useContext, useEffect, useState, useCallback } from 'react';

// Centralized appearance control. Supports System / Light / Dark, persisted to
// localStorage. Applies the `.dark` class on <html> and sets color-scheme so the
// native form controls and status bar follow the chosen appearance.
const STORAGE_KEY = 'logbookai.appearance';
const MODES = ['system', 'light', 'dark'];

function prefersDark() {
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(mode) {
  const isDark = mode === 'dark' || (mode === 'system' && prefersDark());
  const root = document.documentElement;
  root.classList.toggle('dark', isDark);
  root.style.colorScheme = isDark ? 'dark' : 'light';
}

const ThemeContext = createContext({ mode: 'system', setTheme: () => {} });

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(() => {
    if (typeof window === 'undefined') return 'system';
    const stored = localStorage.getItem(STORAGE_KEY);
    return MODES.includes(stored) ? stored : 'system';
  });

  useEffect(() => {
    applyTheme(mode);
    try { localStorage.setItem(STORAGE_KEY, mode); } catch (e) {}
  }, [mode]);

  useEffect(() => {
    if (mode !== 'system' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  const setTheme = useCallback((m) => { if (MODES.includes(m)) setMode(m); }, []);

  return <ThemeContext.Provider value={{ mode, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}