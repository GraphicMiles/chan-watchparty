import { registerPlugin } from '@capacitor/core';

export interface Show {
  title: string;
  slug: string;
  name: string;
  url: string;
  matchScore: number;
  guessed: boolean;
}

export interface Season {
  number: number;
  url: string;
  label: string;
}

export interface Episode {
  number: number;
  title: string;
  url: string;
}

export interface SearchResponse {
  shows: Show[];
}

export interface SeasonsResponse {
  seasons: Season[];
}

export interface EpisodesResponse {
  episodes: Episode[];
}

export interface ResolveResponse {
  url: string | null;
}

export interface O2TvPlugin {
  search(options: { query: string }): Promise<SearchResponse>;
  getSeasons(options: { showSlug: string }): Promise<SeasonsResponse>;
  getEpisodes(options: { showSlug: string; seasonNum: number }): Promise<EpisodesResponse>;
  resolveEpisode(options: {
    showName: string;
    showSlug: string;
    seasonNum: number;
    epNum: number;
    captchaSolverEndpoint?: string;
    authToken?: string;
  }): Promise<ResolveResponse>;
}

const O2TvPlugin = registerPlugin<O2TvPlugin>('O2TvPlugin', {
  web: () => import('./O2TvWeb').then(m => new m.O2TvWeb()),
});

export { O2TvPlugin };
