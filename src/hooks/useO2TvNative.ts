import { useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { O2TvPlugin } from '../native/O2TvPlugin';
import type { Episode, Season, Show } from '../native/O2TvPlugin';
import { useAuth } from '../shared/auth/hooks/useAuth.jsx';
import { apiPath } from '../shared/lib/api.js';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]);
}

/**
 * Android-only O2TV fast path.
 *
 * This deliberately does not duplicate the server resolver: callers keep the
 * existing authenticated /api/media flow as their fallback whenever this
 * returns null/empty or throws. The native plugin scrapes from the device IP,
 * which is the part the server cannot reliably do when upstream blocks it.
 */
export function useO2TvNative() {
  const { user } = useAuth();
  const isNativeAvailable = Capacitor.isNativePlatform()
    && Capacitor.isPluginAvailable('O2TvPlugin');

  const searchNative = useCallback(async (query: string): Promise<Show[] | null> => {
    const clean = String(query || '').trim();
    if (!isNativeAvailable || !clean) return null;
    const result = await withTimeout(O2TvPlugin.search({ query: clean }), 25_000, 'Native O2TV search');
    return Array.isArray(result?.shows) ? result.shows : [];
  }, [isNativeAvailable]);

  const getNativeSeasons = useCallback(async (showSlug: string): Promise<Season[] | null> => {
    const slug = String(showSlug || '').trim();
    if (!isNativeAvailable || !slug) return null;
    const result = await withTimeout(O2TvPlugin.getSeasons({ showSlug: slug }), 20_000, 'Native O2TV seasons');
    return Array.isArray(result?.seasons) ? result.seasons : [];
  }, [isNativeAvailable]);

  const getNativeEpisodes = useCallback(async (
    showSlug: string,
    seasonNum: number,
  ): Promise<Episode[] | null> => {
    const slug = String(showSlug || '').trim();
    const season = Number(seasonNum) || 0;
    if (!isNativeAvailable || !slug || season < 1) return null;
    const result = await withTimeout(
      O2TvPlugin.getEpisodes({ showSlug: slug, seasonNum: season }),
      20_000,
      'Native O2TV episodes',
    );
    return Array.isArray(result?.episodes) ? result.episodes : [];
  }, [isNativeAvailable]);

  const resolveNativeEpisode = useCallback(async ({
    showName,
    showSlug,
    seasonNum,
    epNum,
  }: {
    showName: string;
    showSlug: string;
    seasonNum: number;
    epNum: number;
  }): Promise<string | null> => {
    const slug = String(showSlug || '').trim();
    const season = Number(seasonNum) || 0;
    const episode = Number(epNum) || 0;
    if (!isNativeAvailable || !user || !slug || season < 1 || episode < 1) return null;

    const authToken = await user.getIdToken().catch(() => undefined);
    const result = await withTimeout(
      O2TvPlugin.resolveEpisode({
        showName: String(showName || slug.replace(/-/g, ' ')),
        showSlug: slug,
        seasonNum: season,
        epNum: episode,
        captchaSolverEndpoint: apiPath('/api/media'),
        authToken,
      }),
      75_000,
      'Native O2TV resolve',
    );
    const url = String(result?.url || '').trim();
    return /^https?:\/\//i.test(url) ? url : null;
  }, [isNativeAvailable, user]);

  return {
    isNativeAvailable,
    searchNative,
    getNativeSeasons,
    getNativeEpisodes,
    resolveNativeEpisode,
  };
}
