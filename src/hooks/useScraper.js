import { useState, useCallback } from 'react';

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Unexpected response (HTTP ${res.status})`);
  }

  if (!res.ok || !data.success) {
    throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  }

  return data;
}

export function useScraper() {
  const [results, setResults] = useState([]);
  const [lastQuery, setLastQuery] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  /**
   * On-demand only -- fires exactly once per call, never scheduled.
   * Pass either `{ query, site }` (site must support search, e.g. IMDb)
   * or `{ url, site }` (paste the exact page to parse).
   */
  const scrape = useCallback(async ({ url, query, site }) => {
    if (!url && !query) return;
    setLoading(true);
    setError(null);

    try {
      const data = await postJson('/api/scrape', { url, query, site });
      setResults(data.results);
      setLastQuery({ type: 'scrape', site, query: query || url });
    } catch (err) {
      setError(err.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const search = useCallback(async (query) => {
    if (!query) return;
    setLoading(true);
    setError(null);

    try {
      const data = await postJson('/api/search', { query, source: 'youtube' });
      setResults(data.results);
      setLastQuery({ type: 'search', site: 'youtube', query });
    } catch (err) {
      setError(err.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const clear = useCallback(() => {
    setResults([]);
    setError(null);
    setLastQuery(null);
  }, []);

  return { scrape, search, results, lastQuery, loading, error, clear };
}
