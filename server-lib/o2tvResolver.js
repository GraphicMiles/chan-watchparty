/**
 * O2TV Resolver Engine
 *
 * Resolves o2tv/tvshows4mobile CDN URLs by:
 * 1. Searching tvshows4mobile.org for the show
 * 2. Scraping season → episode pages
 * 3. Probing CDN servers to find the actual file suffix (otv-XXXXX)
 *
 * The CDN URL pattern is:
 *   http://d{N}.o2tv.org/{Show}/Season%20{SS}/{Show}%20-%20S{SS}E{EE}%20(TvShows4Mobile.Com)%20{suffix}.mp4
 *
 * The suffix is unpredictable (e.g., otv-w9l56), so we probe multiple candidates.
 */

import * as cheerio from 'cheerio'

const BASE_URL = 'https://tvshows4mobile.org'
const CDN_HOSTS = ['d6', 'd2', 'd4', 'd8', 'd1']
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const TIMEOUT_MS = 8000

// ─── In-memory CDN suffix cache: showKey → { suffix, ts } ───
const suffixCache = new Map()
const CACHE_TTL = 4 * 60 * 60 * 1000 // 4 hours

// ─── Fetch HTML from tvshows4mobile.org ───
async function fetchPage(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

// ─── HEAD-probe a single CDN URL ───
async function probeUrl(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    })
    clearTimeout(timer)
    if (res.ok || res.status === 206) return true
  } catch { /* next */ }
  clearTimeout(timer)
  return false
}

// ─── Normalize text for matching ───
function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim()
}

// ─── Simple deterministic hash → 5-char alphanumeric ───
function simpleHash(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0
  }
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  let v = Math.abs(h)
  for (let i = 0; i < 5; i++) {
    result += chars[v % chars.length]
    v = Math.floor(v / chars.length)
  }
  return result
}

// ─── Build a CDN URL for a given show/season/episode/suffix ───
function buildCdnUrl(cdnHost, showName, seasonNum, epNum, suffix) {
  const encoded = encodeURIComponent(showName)
  const s = String(seasonNum).padStart(2, '0')
  const e = String(epNum).padStart(2, '0')
  if (suffix) {
    return `http://${cdnHost}.o2tv.org/${encoded}/Season%20${s}/${encoded}%20-%20S${s}E${e}%20(TvShows4Mobile.Com)%20${encodeURIComponent(suffix)}.mp4`
  }
  return `http://${cdnHost}.o2tv.org/${encoded}/Season%20${s}/${encoded}%20-%20S${s}E${e}%20(TvShows4Mobile.Com).mp4`
}

// ─── Generate suffix candidates for probing ───
function generateSuffixCandidates(showSlug) {
  const candidates = []

  // 1. Extract otv suffix from the show slug (e.g., "House-of-the-Dragon-otviao8f" → "otv-iao8f")
  const slugOtvMatch = showSlug.match(/-otv([a-z0-9]+)$/i)
  if (slugOtvMatch) {
    const raw = slugOtvMatch[1]
    candidates.push(`otv-${raw}`)
    candidates.push(`otv${raw}`)
    // Try splitting the suffix differently (e.g., "iao8f" might become "i", "ao8f")
    if (raw.length >= 5) {
      candidates.push(`otv-${raw.slice(1)}`)
      candidates.push(`otv-${raw.slice(0, -1)}`)
    }
  }

  // 2. Common historical suffixes (collected from tvshows4mobile.org slugs)
  const known = [
    'otv-1awrk', 'otv-w9l56', 'otv-2uf8y', 'otv-chmow',
    'otv-2yu7t', 'otv-rai6s', 'otv-iao8f', 'otv-rozuq',
    'otv-l628m', 'otv-hrtc6', 'otv-i5t19', 'otv-rs7vw',
    'otv-ebkpf', 'otv-7sup5', 'otv-4ifkb', 'otv-m5so3',
    'otv-1i8tn', 'otv-a47ys', 'otv-a7s5e', 'otv-q26cr',
    'otv-pri15', 'otv-2mvku', 'otv-tngqk', 'otv-3ibgv',
    'otv-ulvne', 'otv-buhfs', 'otv-hdoja', 'otv-dpo37',
    'otv-npk27', 'otv-vl628m',
  ]
  for (const s of known) {
    if (!candidates.includes(s)) candidates.push(s)
  }

  // 3. Try without any suffix
  candidates.push('')

  // 4. 3-char systematic suffixes (first 730 = a-z + a0-z9)
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < chars.length; i++) {
    for (let j = 0; j < chars.length; j++) {
      candidates.push(`otv-${chars[i]}${chars[j]}`)
      if (candidates.length > 1000) break
    }
    if (candidates.length > 1000) break
  }

  return candidates
}

// ─── Probe CDN for a working URL ───
async function probeCdnForEpisode(showName, seasonNum, epNum, showSlug, maxConcurrency = 20) {
  const cacheKey = `${showName}|S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`

  // Check cache
  const cached = suffixCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return { suffix: cached.suffix, url: buildCdnUrl(CDN_HOSTS[0], showName, seasonNum, epNum, cached.suffix) }
  }

  const candidates = generateSuffixCandidates(showSlug || '')

  // Probe in batches
  for (let batchStart = 0; batchStart < candidates.length; batchStart += maxConcurrency) {
    const batch = candidates.slice(batchStart, batchStart + maxConcurrency)
    const probes = batch.map(async (suffix) => {
      const url = buildCdnUrl(CDN_HOSTS[0], showName, seasonNum, epNum, suffix)
      const ok = await probeUrl(url)
      return ok ? suffix : null
    })

    const results = await Promise.all(probes)
    const hit = results.find(r => r !== null)
    if (hit !== undefined) {
      const suffix = hit
      suffixCache.set(cacheKey, { suffix, ts: Date.now() })
      return { suffix, url: buildCdnUrl(CDN_HOSTS[0], showName, seasonNum, epNum, suffix) }
    }
  }

  return null
}

// ─── Search tvshows4mobile.org for a show ───
export async function searchO2Tv(query, maxResults = 10) {
  try {
    // The ?s= search uses Google CSE which we can't use server-side.
    // Instead, scrape the list_all_tv_series page and filter by query.
    const html = await fetchPage(`${BASE_URL}/search/list_all_tv_series`)
    const $ = cheerio.load(html)
    const results = []
    const qNorm = normalize(query)

    // Show links on the list page
    $('a[href*="tvshows4mobile.org/"]').each((_, el) => {
      const href = $(el).attr('href') || ''
      const text = $(el).text().trim()
      if (!href || !text) return

      // Only match show root links (not season/episode/css/etc)
      const showMatch = href.match(/tvshows4mobile\.org\/([^/]+)\/(?:index\.html)?$/)
      if (!showMatch) return

      // Skip utility links
      if (/^(search|css|images|download|enable-javascript)/i.test(showMatch[1])) return

      const showSlug = showMatch[1]
      const titleNorm = normalize(text)

      // Match check: query tokens must appear in title
      if (!titleNorm.includes(qNorm) && qNorm.length >= 3) {
        // Also try: every query word appears in title
        const qWords = qNorm.split(/(.{3,})/).filter(Boolean)
        if (qWords.length > 1) {
          const allPresent = qWords.every(w => titleNorm.includes(w))
          if (!allPresent) return
        } else {
          return
        }
      }

      // Extract clean show name from title text
      const showName = text.trim()

      results.push({
        title: showName,
        showSlug,
        showName,
        url: href,
        source: 'o2tv',
        matchScore: titleNorm === qNorm ? 100 : (titleNorm.includes(qNorm) ? 80 : 50),
      })
    })

    // Deduplicate by show slug and sort by match score
    const seen = new Set()
    const deduped = results
      .filter(r => {
        if (seen.has(r.showSlug)) return false
        seen.add(r.showSlug)
        return true
      })
      .sort((a, b) => b.matchScore - a.matchScore)

    return deduped.slice(0, maxResults)
  } catch (err) {
    console.error('O2TV search failed:', err.message)
    return []
  }
}

// ─── Get all seasons for a show from its page ───
export async function getO2TvSeasons(showSlug) {
  try {
    const html = await fetchPage(`${BASE_URL}/${showSlug}/`)
    const $ = cheerio.load(html)
    const seasons = []

    $('a[href*="Season-"]').each((_, el) => {
      const href = $(el).attr('href') || ''
      const match = href.match(/Season-(\d+)/)
      if (match) {
        const num = parseInt(match[1], 10)
        if (!seasons.find(s => s.number === num)) {
          seasons.push({
            number: num,
            url: href,
            label: `Season ${num}`,
          })
        }
      }
    })

    return seasons.sort((a, b) => a.number - b.number)
  } catch (err) {
    console.error('O2TV seasons failed:', err.message)
    return []
  }
}

// ─── Get episodes for a season ───
export async function getO2TvEpisodes(showSlug, seasonNum) {
  try {
    const seasonPath = `${showSlug}/Season-${String(seasonNum).padStart(2, '0')}`
    const html = await fetchPage(`${BASE_URL}/${seasonPath}/`)
    const $ = cheerio.load(html)
    const episodes = []

    $('a[href*="Episode-"]').each((_, el) => {
      const href = $(el).attr('href') || ''
      const text = $(el).text().trim()
      const match = href.match(/Episode-(\d+)/)
      if (match) {
        const num = parseInt(match[1], 10)
        if (!episodes.find(e => e.number === num)) {
          episodes.push({
            number: num,
            title: text || `Episode ${num}`,
            url: href,
          })
        }
      }
    })

    return episodes.sort((a, b) => a.number - b.number)
  } catch (err) {
    console.error('O2TV episodes failed:', err.message)
    return []
  }
}

// ─── Resolve a single episode to a direct CDN URL ───
export async function resolveO2TvEpisode(showName, showSlug, seasonNum, epNum) {
  const result = await probeCdnForEpisode(showName, seasonNum, epNum, showSlug)
  if (result) {
    const s = String(seasonNum).padStart(2, '0')
    const e = String(epNum).padStart(2, '0')
    return {
      title: `${showName} - S${s}E${e}`,
      url: result.url,
      link: result.url,
      source: 'o2tv',
      isDirect: true,
      playableInRoom: true,
      quality: 'HD',
    }
  }
  return null
}

// ─── Main resolver: search → list episodes with CDN URLs ───
export async function resolveO2TvShow(query, maxSeasons = 4, maxEpisodes = 10) {
  try {
    // Step 1: Search for the show
    const shows = await searchO2Tv(query, 5)
    if (!shows.length) {
      // Fallback: try constructing from query directly
      const cleanName = query.trim()
      return await resolveO2TvByName(cleanName, '', maxSeasons, maxEpisodes)
    }

    // Pick the best match (already sorted by matchScore)
    const show = shows[0]

    // Step 2: Get seasons
    const seasons = await getO2TvSeasons(show.showSlug)
    if (!seasons.length) {
      return await resolveO2TvByName(show.showName, show.showSlug, maxSeasons, maxEpisodes)
    }

    // Step 3: Probe CDN for the first episode of the first season to warm cache
    // Then verify each subsequent episode — suffixes are per-episode, not per-show
    const firstSeason = seasons[0]
    const firstEpResult = await probeCdnForEpisode(show.showName, firstSeason.number, 1, show.showSlug)

    if (firstEpResult) {
      // Use the first episode's suffix as a seed for others (same suffix sometimes works)
      // but VERIFY each URL before marking it playable
      const seedSuffix = firstEpResult.suffix
      const results = []
      const verifyQueue = []

      for (const season of seasons.slice(0, maxSeasons)) {
        const episodes = await getO2TvEpisodes(show.showSlug, season.number)
        for (const ep of episodes.slice(0, maxEpisodes)) {
          const s = String(season.number).padStart(2, '0')
          const e = String(ep.number).padStart(2, '0')
          const seedUrl = buildCdnUrl(CDN_HOSTS[0], show.showName, season.number, ep.number, seedSuffix)
          const cacheKey = `${show.showName}|S${s}E${e}`
          verifyQueue.push({ season, ep, s, e, seedUrl, cacheKey })
        }
      }

      // Verify all seed URLs concurrently (20 at a time)
      for (let i = 0; i < verifyQueue.length; i += 20) {
        const batch = verifyQueue.slice(i, i + 20)
        const checks = await Promise.all(batch.map(async (item) => {
          const works = await probeUrl(item.seedUrl)
          return { ...item, works }
        }))

        for (const item of checks) {
          if (item.works) {
            suffixCache.set(item.cacheKey, { suffix: seedSuffix, ts: Date.now() })
            results.push({
              title: `${show.showName} - S${item.s}E${item.e}`,
              url: item.seedUrl,
              link: item.seedUrl,
              source: 'o2tv',
              isDirect: true,
              playableInRoom: true,
              quality: 'HD',
            })
          } else {
            // Seed suffix didn't work — probe this episode individually
            const probed = await probeCdnForEpisode(show.showName, item.season.number, item.ep.number, show.showSlug)
            if (probed) {
              results.push({
                title: `${show.showName} - S${item.s}E${item.e}`,
                url: probed.url,
                link: probed.url,
                source: 'o2tv',
                isDirect: true,
                playableInRoom: true,
                quality: 'HD',
              })
            } else {
              // Last resort: fallback URL (may 404 at playback)
              const slugSuffix = show.showSlug.match(/-otv([a-z0-9]+)$/i)?.[1] || '1awrk'
              const fallbackUrl = buildCdnUrl(CDN_HOSTS[0], show.showName, item.season.number, item.ep.number, `otv-${slugSuffix}`)
              results.push({
                title: `${show.showName} - S${item.s}E${item.e}`,
                url: fallbackUrl,
                link: fallbackUrl,
                source: 'o2tv',
                isDirect: true,
                playableInRoom: false,
                quality: 'HD',
                probeFailed: true,
              })
            }
          }
        }
      }

      return results
    }

    // Step 4: If first-episode probe failed, probe each episode individually
    const results = []
    const seasonsToProcess = seasons.slice(0, maxSeasons)

    for (const season of seasonsToProcess) {
      const episodes = await getO2TvEpisodes(show.showSlug, season.number)
      const epsToProcess = episodes.slice(0, maxEpisodes)

      // Probe concurrently within a season
      const resolved = await Promise.all(epsToProcess.map(async (ep) => {
        const result = await resolveO2TvEpisode(show.showName, show.showSlug, season.number, ep.number)
        if (!result) {
          const s = String(season.number).padStart(2, '0')
          const e = String(ep.number).padStart(2, '0')
          const slugSuffix = show.showSlug.match(/-otv([a-z0-9]+)$/i)?.[1] || '1awrk'
          const fallbackUrl = buildCdnUrl(CDN_HOSTS[0], show.showName, season.number, ep.number, `otv-${slugSuffix}`)
          return {
            title: `${show.showName} - S${s}E${e}`,
            url: fallbackUrl,
            link: fallbackUrl,
            source: 'o2tv',
            isDirect: true,
            playableInRoom: false,
            quality: 'HD',
            probeFailed: true,
          }
        }
        return result
      }))

      results.push(...resolved)
    }

    return results
  } catch (err) {
    console.error('O2TV resolution failed:', err.message)
    return []
  }
}

// ─── Fallback: resolve by name only (no tvshows4mobile scraping) ───
async function resolveO2TvByName(showName, slugHint, maxSeasons, maxEpisodes) {
  const results = []
  const slugSuffix = slugHint || showName.replace(/\s+/g, '-')

  for (let season = 1; season <= maxSeasons; season++) {
    for (let ep = 1; ep <= maxEpisodes; ep++) {
      const result = await resolveO2TvEpisode(showName, slugSuffix, season, ep)
      if (result) {
        results.push(result)
      } else {
        const s = String(season).padStart(2, '0')
        const e = String(ep).padStart(2, '0')
        const suffix = slugSuffix.match(/otv([a-z0-9]+)$/i)?.[1] || '1awrk'
        const fallbackUrl = buildCdnUrl(CDN_HOSTS[0], show.showName || showName, season, ep, `otv-${suffix}`)
        results.push({
          title: `${showName} - S${s}E${e}`,
          url: fallbackUrl,
          link: fallbackUrl,
          source: 'o2tv',
          isDirect: true,
          playableInRoom: false,
          quality: 'HD',
          probeFailed: true,
        })
      }
    }
  }

  return results
}

// ─── Quick probe: check if a CDN URL works, if not try alternatives ───
export async function probeAndFixO2TvUrl(originalUrl) {
  // If the URL works, return it
  if (await probeUrl(originalUrl)) return originalUrl

  try {
    const parsed = new URL(originalUrl)
    const pathParts = parsed.pathname.split('/').filter(Boolean).map(p => decodeURIComponent(p))
    if (pathParts.length < 3) return originalUrl

    const showName = pathParts[0]
    // Season path is "Season 01" — extract the number after "Season "
    const seasonMatch = pathParts[1]?.match(/Season\s+(\d+)/i)
    const seasonNum = seasonMatch ? parseInt(seasonMatch[1], 10) : 1

    const filename = pathParts[pathParts.length - 1]
    const epMatch = filename.match(/S\d+E(\d+)/i)
    const epNum = epMatch ? parseInt(epMatch[1], 10) : 1

    const result = await probeCdnForEpisode(showName, seasonNum, epNum, '')
    if (result) return result.url

    return originalUrl
  } catch {
    return originalUrl
  }
}

// ─── Warm up the suffix cache by probing the first episode ───
export async function warmO2TvCache(showName, slugHint, seasonNum = 1) {
  const result = await probeCdnForEpisode(showName, seasonNum, 1, slugHint)
  if (result) {
    const suffix = result.suffix
    for (let ep = 2; ep <= 10; ep++) {
      const cacheKey = `${showName}|S${String(seasonNum).padStart(2, '0')}E${String(ep).padStart(2, '0')}`
      suffixCache.set(cacheKey, { suffix, ts: Date.now() })
    }
    return suffix
  }
  return null
}
