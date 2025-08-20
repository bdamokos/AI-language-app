import { useCallback, useState } from 'react';

/**
 * useBaseText: fetch or generate a base text for a topic/language/level.
 * Options can include excludeIds (array of baseText ids) and focus (string) for specialized emphasis.
 * Returns { fetchBaseText, loading, error, last } where last is the last fetched base text.
 */
export default function useBaseText() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [last, setLast] = useState(null);

  const fetchBaseText = useCallback(async ({ topic, language = 'es', level = 'B1', challengeMode = false, excludeIds = [], focus } = {}) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch('/api/base-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, language, level, challengeMode, excludeIds, focus })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'Failed to get base text');
      setLast(data);
      return data;
    } catch (e) {
      setError(e.message || 'Failed to get base text');
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  return { fetchBaseText, loading, error, last };
}


