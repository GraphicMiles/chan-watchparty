/**
 * Shared result-type classification for Nkiri / O2TV search results.
 *
 * Both surfaces that render search results (the Media Browser's ShowBrowser
 * and the in-room Queue search) use this ONE module to decide whether a
 * result is a seasonal/series page (real episode list underneath) or a
 * standalone movie/file (play it directly — never expand a nested raw card).
 *
 * Signals, in priority order:
 *   1. Title markers — series ("Season 03", "S02E05", "complete series")
 *      vs movie (year + release-group markers like "2018 BluRay").
 *   2. Server classification fields (o2tvKind / requiresEpisodes / counts).
 *   3. Already-playable flags (isDirect / direct file URL).
 */

const SERIES_RE = /\b(season\s*\d+|s\d{1,2}(\s*e\d{1,3})?|complete\s+(season|series|tv\s*series)|full\s+tv\s*series|all\s+seasons|box\s*set)\b/i

const YEAR_RE = /\(?\b(?:19|20)\d{2}\b\)?/

const RELEASE_RE = /\b(blu-?ray|web-?dl|web-?rip|hd-?rip|br-?rip|dvd-?rip|hdtv|x264|x265|h264|hevc|10bit|2160p|1080p|720p|480p)\b/i

const FILE_RE = /\.(mp4|mkv|avi|mov|webm|flv|ts|m3u8)(\?|#|$)/i

/** Title reads like a season/series entry ("Silo — Season 03"). */
export function isSeriesTitle(title) {
  return SERIES_RE.test(String(title || ''))
}

/** Title reads like a standalone movie/release ("Avengers (2018) BluRay 1080p"). */
export function isMovieTitle(title) {
  const t = String(title || '')
  if (FILE_RE.test(t)) return true
  // Year in parentheses ("(2018)") is the classic Nkiri movie title shape.
  if (YEAR_RE.test(t)) return true
  // Resolution markers alone (1080p/720p/4K + a release group) strongly imply
  // a file/release, not a series listing.
  return RELEASE_RE.test(t) && /\b(?:2160p|1440p|1080p|720p|480p|4k)\b/i.test(t)
}

/**
 * True when the result represents a season/series whose page has a real
 * episode list underneath (so an expand/drill affordance is justified).
 */
export function isSeasonalResult(item) {
  if (!item) return false
  const title = item.title || ''

  // Title signals win — the Nkiri search API marks every hit as a "show",
  // so we must look at the actual title first (movies carry year + release
  // markers, series carry season markers).
  if (isSeriesTitle(title)) return true
  if (isMovieTitle(title)) return false

  const kind = String(item.o2tvKind || '')
  // Server-level "this is a flat file" classifications
  if (kind === 'nkiri-direct' || kind === 'direct' || kind === 'nkiri-episode' || kind === 'episode') return false
  if (Number(item.episodeCount) > 1 || Number(item.count) > 1) return true
  if (kind === 'nkiri-show' || kind === 'show' || kind === 'season') return true
  if (item.requiresEpisodes === true) return true
  return false
}

/**
 * True when the result is a standalone media file / movie that can (or must)
 * be played directly without an episode drill.
 */
export function isStandaloneResult(item) {
  if (!item) return false
  if (item.isDirect || item.playableInRoom === true || isDirectFileUrl(item.url || item.link)) return true
  const kind = String(item.o2tvKind || '')
  if (kind === 'nkiri-direct' || kind === 'direct') return true
  if (isSeasonalResult(item)) return false
  const title = item.title || ''
  return isMovieTitle(title) || FILE_RE.test(title)
}

/** Is this URL a direct media file (not a page)? */
export function isDirectFileUrl(url) {
  return FILE_RE.test(String(url || ''))
}
