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

  const search = useCallback(async (query, source = 'youtube') => {
    if (!query) return;
    setLoading(true);
    setError(null);

    try {
      let data;

      if (source === 'omdb') {
        // OMDb has no referrer restriction, so the server route works fine here.
        data = await postJson('/api/search', { query, source: 'omdb' });
      } else if (import.meta.env.VITE_YOUTUBE_API_KEY) {
        const apiKey = import.meta.env.VITE_YOUTUBE_API_KEY;
        // YouTube API keys are typically restricted by HTTP referrer, so this
        // must be called from the browser directly rather than proxied through
        // our server (which has no browser referer and would get blocked).
        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=12&q=${encodeURIComponent(query)}&key=${apiKey}`
        );
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body?.error?.message || `YouTube API responded with HTTP ${res.status}`);
        }
        data = {
          results: (body.items || []).map((item) => ({
            id: item.id.videoId,
            title: item.snippet.title,
            thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url,
            channel: item.snippet.channelTitle,
            published: item.snippet.publishedAt,
            url: `https://youtube.com/watch?v=${item.id.videoId}`,
            source: 'youtube',
          })),
        };
      } else {
        // Fall back to the server route, for setups using an unrestricted server-side key.
        data = await postJson('/api/search', { query, source: 'youtube' });
      }

      setResults(data.results);
      setLastQuery({ type: 'search', site: source, query });
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
