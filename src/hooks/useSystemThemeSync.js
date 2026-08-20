import { useEffect } from 'react';

// Auto-sync the app theme with the OS color scheme by toggling the `.dark`
// class on <html>. Runs once on mount and reacts to system changes.
export default function useSystemThemeSync() {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', mq.matches);
    apply();
    const handler = () => apply();
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
}