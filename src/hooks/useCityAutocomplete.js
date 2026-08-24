import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

const cache = new Map();
const MAX_CACHE_SIZE = 40;

export default function useCityAutocomplete(query, enabled = true) {
  const [state, setState] = useState({ suggestions: [], loading: false, error: '' });

  useEffect(() => {
    const key = String(query || '').trim().toLowerCase();
    if (!enabled || key.length < 3) {
      setState({ suggestions: [], loading: false, error: '' });
      return;
    }
    if (cache.has(key)) {
      setState({ suggestions: cache.get(key), loading: false, error: '' });
      return;
    }

    let current = true;
    const timer = setTimeout(async () => {
      setState((previous) => ({ ...previous, loading: true, error: '' }));
      try {
        const response = await base44.functions.invoke('cityAutocomplete', { query: key });
        if (!current) return;
        const suggestions = (response.data?.suggestions || []).slice(0, 5);
        cache.set(key, suggestions);
        if (cache.size > MAX_CACHE_SIZE) cache.delete(cache.keys().next().value);
        setState({ suggestions, loading: false, error: '' });
      } catch (error) {
        if (current) setState({ suggestions: [], loading: false, error: error.message || 'Lookup unavailable' });
      }
    }, 600);

    return () => { current = false; clearTimeout(timer); };
  }, [query, enabled]);

  return state;
}