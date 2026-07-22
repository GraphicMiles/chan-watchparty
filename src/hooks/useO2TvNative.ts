import { useState, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { O2TvPlugin, Show, Season, Episode } from '../native/O2TvPlugin';

/**
 * Hook that uses native O2TV plugin on Android, falls back to server on web
 */
export function useO2TvNative() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isNative = Capacitor.isNativePlatform();

  const search = useCallback(async (query: string): Promise<Show[]> => {
    setLoading(true);
    setError(null);
    try {
      if (isNative) {
        const result = await O2TvPlugin.search({ query });
        return result.shows;
      } else {
        // Fallback to server
        const response = await fetch('/api/media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'search', layer: 'direct', query }),
        });
        const data = await response.json();
        return data.results || [];
      }
    } catch (err: any) {
      setError(err.message || 'Search failed');
      return [];
    } finally {
      setLoading(false);
    }
  }, [isNative]);

  const getSeasons = useCallback(async (showSlug: string): Promise<Season[]> => {
    setLoading(true);
    setError(null);
    try {
      if (isNative) {
        const result = await O2TvPlugin.getSeasons({ showSlug });
        return result.seasons;
      } else {
        const response = await fetch('/api/media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'o2tvSeasons', showSlug }),
        });
        const data = await response.json();
        return data.results || [];
      }
    } catch (err: any) {
      setError(err.message || 'Get seasons failed');
      return [];
    } finally {
      setLoading(false);
    }
  }, [isNative]);

  const getEpisodes = useCallback(async (showSlug: string, seasonNum: number): Promise<Episode[]> => {
    setLoading(true);
    setError(null);
    try {
      if (isNative) {
        const result = await O2TvPlugin.getEpisodes({ showSlug, seasonNum });
        return result.episodes;
      } else {
        const response = await fetch('/api/media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'o2tvEpisodes', showSlug, seasonNum }),
        });
        const data = await response.json();
        return data.results || [];
      }
    } catch (err: any) {
      setError(err.message || 'Get episodes failed');
      return [];
    } finally {
      setLoading(false);
    }
  }, [isNative]);

  const resolveEpisode = useCallback(async (
    showName: string,
    showSlug: string,
    seasonNum: number,
    epNum: number
  ): Promise<string | null> => {
    setLoading(true);
    setError(null);
    try {
      if (isNative) {
        const result = await O2TvPlugin.resolveEpisode({ showName, showSlug, seasonNum, epNum });
        return result.url;
      } else {
        const response = await fetch('/api/media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'o2tvResolve', showName, showSlug, seasonNum, episodeNum: epNum }),
        });
        const data = await response.json();
        return data.results?.[0]?.url || null;
      }
    } catch (err: any) {
      setError(err.message || 'Resolve episode failed');
      return null;
    } finally {
      setLoading(false);
    }
  }, [isNative]);

  return {
    search,
    getSeasons,
    getEpisodes,
    resolveEpisode,
    loading,
    error,
    isNative,
  };
}
