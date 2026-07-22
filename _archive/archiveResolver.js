/**
 * Internet Archive Resolver
 *
 * Resolves archive.org details pages to direct MP4 streaming URLs.
 * Uses the /metadata/{identifier} JSON API to discover all files.
 *
 * URL patterns:
 *   archive.org/details/{identifier}           → details page (may have many files)
 *   archive.org/download/{identifier}/{file}    → direct file download
 *
 * Multi-file collections (e.g. TV series with many episodes) are fully expanded.
 * The .ia.mp4 variant (H.264 IA re-encode) is preferred for browser playback
 * as it's specifically formatted for the IA video player.
 *
 * Also improves search by using the metadata API to find the actual MP4 file
 * path instead of guessing with the naive /{identifier}/{identifier}.mp4 pattern.
 */

/**
 * Resolve an archive.org details page URL to direct streaming URLs
 * @param {string} pageUrl - The archive.org/details/{identifier} URL
 * @returns {Promise<Array<{title, url, source, isDirect, playableInRoom}>>}
 */
export async function resolveArchiveOrgPage(pageUrl) {
  try {
    const identifier = extractIdentifier(pageUrl)
    if (!identifier) return []

    const meta = await fetchMetadata(identifier)
    if (!meta) return []

    const mp4Files = getPlayableFiles(meta)

    if (mp4Files.length === 0) return []

    const title = meta.metadata?.title || identifier
    const thumb = `https://archive.org/services/img/${identifier}`

    // If there's only one MP4 file, return a single result
    if (mp4Files.length === 1) {
      const file = mp4Files[0]
      const url = buildFileUrl(identifier, file.name)
      return [{
        title: cleanFileName(file.name) || title,
        url,
        link: url,
        thumbnail: thumb,
        image: thumb,
        source: 'archiveorg',
        type: 'direct',
        isDirect: true,
        playableInRoom: true,
        quality: detectQuality(file.name),
        meta: formatFileSize(file.size),
        resolvedFrom: pageUrl,
      }]
    }

    // Multiple files — return each as a separate result, sorted by season/episode
    const sorted = sortEpisodes(mp4Files)
    return sorted.map((file) => {
      const url = buildFileUrl(identifier, file.name)
      return {
        title: cleanFileName(file.name) || `${title} - Episode`,
        url,
        link: url,
        thumbnail: thumb,
        image: thumb,
        source: 'archiveorg',
        type: 'direct',
        isDirect: true,
        playableInRoom: true,
        quality: detectQuality(file.name),
        meta: formatFileSize(file.size),
        resolvedFrom: pageUrl,
      }
    })
  } catch (err) {
    console.error('Archive.org resolution error:', err.message)
    return []
  }
}

/**
 * Enhance an archive.org search result by verifying the MP4 file actually exists
 * and finding the correct path (instead of guessing /{identifier}/{identifier}.mp4)
 * @param {string} identifier - The archive.org identifier
 * @returns {Promise<string|null>} The first playable MP4 URL, or null
 */
export async function resolveArchiveOrgDirectUrl(identifier) {
  try {
    const meta = await fetchMetadata(identifier)
    if (!meta) return null

    const mp4Files = getPlayableFiles(meta)
    if (mp4Files.length === 0) return null

    // Prefer the .ia.mp4 variant (H.264 IA) or first MP4
    const iaMp4 = mp4Files.find(f => f.name.endsWith('.ia.mp4'))
    const file = iaMp4 || mp4Files[0]

    return buildFileUrl(identifier, file.name)
  } catch {
    return null
  }
}

/**
 * Extract the identifier from an archive.org URL
 * Supports: /details/{id}, /download/{id}/..., /metadata/{id}
 */
function extractIdentifier(url) {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname

    // /details/{identifier}
    const detailsMatch = path.match(/\/details\/([^/?#]+)/)
    if (detailsMatch) return detailsMatch[1]

    // /download/{identifier}/...
    const downloadMatch = path.match(/\/download\/([^/?#]+)/)
    if (downloadMatch) return downloadMatch[1]

    // /metadata/{identifier}
    const metaMatch = path.match(/\/metadata\/([^/?#]+)/)
    if (metaMatch) return metaMatch[1]

    return null
  } catch {
    return null
  }
}

/**
 * Fetch item metadata from the archive.org JSON API
 * @param {string} identifier
 * @returns {Promise<object|null>}
 */
async function fetchMetadata(identifier) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)

  try {
    const url = `https://archive.org/metadata/${encodeURIComponent(identifier)}`
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ChanServer/1.0)',
        'Accept': 'application/json',
      },
    })
    clearTimeout(timer)

    if (!res.ok) return null
    const data = await res.json()

    // Validate structure
    if (!data || !data.files) return null
    return data
  } catch (err) {
    clearTimeout(timer)
    console.error(`Archive.org metadata fetch failed for ${identifier}:`, err.message)
    return null
  }
}

/**
 * Get playable video files from archive.org metadata
 * Filters for .mp4 files, preferring .ia.mp4 (H.264 IA re-encode for streaming)
 * Deduplicates between .ia.mp4 and .mp4 variants (keeps .ia.mp4 only)
 */
function getPlayableFiles(meta) {
  const files = meta.files || []
  if (!Array.isArray(files)) return []

  // Find all MP4 files
  const mp4s = files.filter(f =>
    f.name && /\.(ia\.)?mp4$/i.test(f.name)
  )

  // Group by base name (without .ia. prefix) to deduplicate
  // e.g. "video.ia.mp4" and "video.mp4" are the same — keep only .ia.mp4
  const groups = new Map()
  for (const file of mp4s) {
    const baseName = file.name.replace(/\.ia\.mp4$/i, '.mp4')
    const existing = groups.get(baseName)
    if (!existing || !existing.name.endsWith('.ia.mp4')) {
      // Prefer .ia.mp4 variant
      groups.set(baseName, file)
    }
  }

  return [...groups.values()]
}

/**
 * Build a direct download URL for an archive.org file
 */
function buildFileUrl(identifier, filename) {
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${filename.split('/').map(s => encodeURIComponent(s)).join('/')}`
}

/**
 * Clean a filename into a readable title
 * e.g. "season-1_DUB-1080p/Attack_on_Titan-E1-1080p.ia.mp4" → "Attack on Titan - E1 (1080p)"
 */
function cleanFileName(name) {
  if (!name) return ''
  // Remove directory path
  let clean = name.split('/').pop() || name
  // Remove extension(s)
  clean = clean.replace(/\.ia\.mp4$/i, '').replace(/\.mp4$/i, '')
  // Replace underscores with spaces
  clean = clean.replace(/_/g, ' ')
  // Replace hyphens with spaced hyphens for readability
  clean = clean.replace(/(\w)-(\w)/g, '$1 - $2')
  // Clean up multiple spaces
  clean = clean.replace(/\s+/g, ' ').trim()
  return clean
}

/**
 * Sort files by season and episode number
 */
function sortEpisodes(files) {
  return [...files].sort((a, b) => {
    const aSeason = extractSeasonNum(a.name)
    const bSeason = extractSeasonNum(b.name)
    if (aSeason !== bSeason) return aSeason - bSeason

    const aEp = extractEpNum(a.name)
    const bEp = extractEpNum(b.name)
    if (aEp !== bSeason) return aEp - bEp

    return a.name.localeCompare(b.name)
  })
}

/**
 * Extract season number from filename
 */
function extractSeasonNum(name) {
  // "season-1_DUB-1080p/..." or "Season 2" or "Final Season, Part 1"
  const lower = name.toLowerCase()

  // "season-3" or "season_3" in directory
  const dirMatch = name.match(/season[^\d]*(\d+)/i)
  if (dirMatch) return parseInt(dirMatch[1], 10)

  // "Final Season, Part 1" → season 4
  if (lower.includes('final season') && lower.includes('part 1')) return 4
  if (lower.includes('final season') && lower.includes('part 2')) return 5
  if (lower.includes('final season')) return 4

  // If no season marker, assume season 1
  return 1
}

/**
 * Extract episode number from filename
 */
function extractEpNum(name) {
  // "Attack_on_Titan-E1-1080p" or "E21" or "Episode 12"
  const match = name.match(/(?:E|Episode\s*)(\d+)/i)
  return match ? parseInt(match[1], 10) : 999
}

/**
 * Detect quality from filename
 */
function detectQuality(name) {
  if (/2160p|4k/i.test(name)) return '4K'
  if (/1080p/i.test(name)) return '1080p'
  if (/720p/i.test(name)) return '720p'
  if (/480p/i.test(name)) return '480p'
  return 'SD'
}

/**
 * Format file size in human-readable form
 */
function formatFileSize(size) {
  if (!size) return null
  const bytes = parseInt(size, 10)
  if (isNaN(bytes) || bytes === 0) return null
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}
