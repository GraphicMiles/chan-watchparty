import { useState, useCallback } from 'react';

export function useScraper() {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const scrape = useCallback(async ({ url, site }) => {
    setLoading(true);
    setError(null);
    
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, site })
      });
      
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      
      setResults(data.results);
      return data.results;
    } catch (err) {
      setError(err.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const search = useCallback(async (query) => {
    setLoading(true);
    setError(null);
    
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, source: 'youtube' })
      });
      
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      
      setResults(data.results);
      return data.results;
    } catch (err) {
      setError(err.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  return { scrape, search, results, loading, error, clear: () => setResults([]) };
}
