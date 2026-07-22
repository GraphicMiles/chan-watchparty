/**
 * O2TV Resolver — Clean rewrite
 *
 * Simple, reliable O2TV (tvshows4mobile.org) resolver.
 * No captcha, no browser, no complex chains — just scrape the site.
 *
 * Flow:
 *   1. searchO2Tv(query) → find the show slug
 *   2. getO2TvSeasons(slug) → list seasons
 *   3. getO2TvEpisodes(slug, seasonNum) → list episodes with download links
 *   4. resolveO2TvEpisode(...) → follow download page → extract CDN URL
 */

import * as cheerio from 'cheerio'

const BASE_URL = 'https://tvshows4mobile.org'
const PROXY_URL = process.env.O2TV_PROXY_URL || 'https://zero2tv-proxy.onrender.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const TIMEOUT_MS = 8000

// ─── HTTP helper (uses proxy for tvshows4mobile.org) ───
async function fetchPage(url, timeoutMs = TIMEOUT_MS, retries = 2) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // Use proxy for tvshows4mobile.org requests
    const fetchUrl = url.includes('tvshows4mobile.org')
      ? `${PROXY_URL}/proxy?url=${encodeURIComponent(url)}`
      : url

    const res = await fetch(fetchUrl, {
      signal: controller.signal,
      headers: fetchUrl.includes('/proxy?')
        ? { 'Accept': 'application/json' }
        : {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
      redirect: 'follow',
    })

    if (!res.ok) {
      if (res.status === 403 && retries > 0 && !fetchUrl.includes('/proxy?')) {
        console.log(`[O2TV] Got 403, retrying in 1s... (${retries} retries left)`)
        clearTimeout(timer)
        await new Promise(r => setTimeout(r, 1000))
        return fetchPage(url, timeoutMs, retries - 1)
      }
      console.error(`[O2TV] HTTP ${res.status} for ${url}`)
      throw new Error(`HTTP ${res.status}`)
    }

    // If using proxy, parse the JSON response
    if (fetchUrl.includes('/proxy?')) {
      const result = await res.json()
      if (result.status !== 200) {
        throw new Error(`Proxy returned HTTP ${result.status}`)
      }
      return result.isBinary
        ? Buffer.from(result.data, 'base64').toString('utf-8')
        : result.data
    }

    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

// ─── Normalize text for matching ───
function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim()
}

function toWords(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean)
}

function stripArticles(words) {
  if (Array.isArray(words) && words.length > 1 && /^(the|a|an)$/.test(words[0])) return words.slice(1)
  return words
}

function normalizeSlug(slug) {
  return String(slug || '')
    .replace(/^download-/i, '')
    .replace(/-otv[a-z0-9]+$/i, '')
    .replace(/-\d+$/i, '')
    .replace(/-/g, ' ')
    .trim()
}

function scoreShowMatch(queryRaw, showName, showSlug) {
  const qNorm = normalize(queryRaw)
  const tNorm = normalize(showName)
  const sNorm = normalize(normalizeSlug(showSlug))
  if (!qNorm) return 0

  if (tNorm === qNorm || sNorm === qNorm) return 100

  const qWords = stripArticles(toWords(queryRaw))
  const tWords = stripArticles(toWords(showName))
  const sWords = stripArticles(toWords(normalizeSlug(showSlug)))
  const qJoined = qWords.join(' ')
  const tJoined = tWords.join(' ')
  const sJoined = sWords.join(' ')

  if (qJoined && (qJoined === tJoined || qJoined === sJoined)) return 98
  if (qJoined && (tJoined.startsWith(qJoined) || sJoined.startsWith(qJoined))) return 95
  if (tNorm.startsWith(qNorm) || sNorm.startsWith(qNorm)) return 90
  if (tNorm.includes(qNorm) || sNorm.includes(qNorm)) return 80

  const tokens = qNorm.match(/[a-z0-9]{3,}/g) || []
  if (tokens.length >= 1) {
    const hay = tNorm + sNorm
    if (tokens.every(t => hay.includes(t))) return 60
  }

  return 0
}

// ═══════════════════════════════════════════════════════════════
// 1. SEARCH — find a show by name
// ═══════════════════════════════════════════════════════════════

export async function searchO2Tv(query, maxResults = 10) {
  const qRaw = String(query || '').trim()
  if (!qRaw) return []

  console.log(`[O2TV] Searching for: "${qRaw}"`)

  try {
    // Fast path: try direct show page probe first
    console.log(`[O2TV] Probing show page...`)
    const probed = await probeShowPage(qRaw)
    console.log(`[O2TV] Probe result:`, probed ? 'found' : 'not found')

    // Also fetch the catalog for broader matching
    let catalog = []
    try {
      console.log(`[O2TV] Fetching catalog...`)
      const html = await fetchPage(`${BASE_URL}/search/list_all_tv_series`, 6000)
      catalog = parseCatalogHtml(html)
      console.log(`[O2TV] Catalog parsed: ${catalog.length} shows`)
    } catch (err) {
      console.error('[O2TV] Catalog fetch failed:', err.message)
    }

    const scored = []

    // Score catalog results
    for (const show of catalog) {
      const matchScore = scoreShowMatch(qRaw, show.showName, show.showSlug)
      if (matchScore <= 0) continue
      scored.push({
        title: show.showName,
        showSlug: show.showSlug,
        showName: show.showName,
        url: show.url,
        source: 'o2tv',
        matchScore,
      })
    }

    // Add probe result if not already present
    if (probed && !scored.some(s => normalize(s.showSlug) === normalize(probed.showSlug))) {
      scored.push(probed)
    }

    scored.sort((a, b) => b.matchScore - a.matchScore)
    const results = scored.slice(0, Math.max(1, Number(maxResults) || 10))
    console.log(`[O2TV] Returning ${results.length} results for "${qRaw}"`)
    return results
  } catch (err) {
    console.error('[O2TV] Search failed:', err.message)
    return []
  }
}

/**
 * Fast probe: check if a direct show page exists.
 * Much faster than fetching the full catalog.
 */
async function probeShowPage(query, retries = 2) {
  const guessSlug = String(query || '').trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!guessSlug || guessSlug.length < 2) return null

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(`${BASE_URL}/${guessSlug}/`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
      },
      redirect: 'follow',
    })
    clearTimeout(timer)

    if (!res.ok) {
      if (res.status === 403 && retries > 0) {
        console.log(`[O2TV] Probe got 403, retrying... (${retries} left)`)
        await new Promise(r => setTimeout(r, 1000))
        return probeShowPage(query, retries - 1)
      }
      return null
    }

    const finalUrl = res.url || ''
    const html = await res.text()

    const isShowPage = /Season-\d+/i.test(html)
      && !/404 Page Not Found/i.test(html)
      && !/list_all_tv_series/i.test(finalUrl)
      && new RegExp(guessSlug, 'i').test(finalUrl + html)

    if (isShowPage) {
      // Extract actual slug from the URL (might differ in case)
      const urlMatch = finalUrl.match(/tvshows4mobile\.org\/([^/]+)\//i)
      const actualSlug = urlMatch ? urlMatch[1] : guessSlug

      // Extract show name from title
      const titleMatch = html.match(/<title>\s*(?:Download\s+)?(.+?)(?:\s+TV Show|\s*[-–|]\s*TvShows)/i)
      const showName = titleMatch ? titleMatch[1].trim() : query

      return {
        title: showName,
        showSlug: actualSlug,
        showName,
        url: `${BASE_URL}/${actualSlug}/index.html`,
        source: 'o2tv',
        matchScore: 95,
        guessed: true,
      }
    }
  } catch {
    /* probe failed */
  }
  return null
}

/**
 * Parse the full show catalog page.
 */
function parseCatalogHtml(html) {
  if (!html) return []
  const shows = []
  const seen = new Set()

  const patterns = [
    /href=["'](https?:\/\/(?:www\.)?tvshows4mobile\.org\/([^/"'#?]+)\/(?:index\.html)?)[^>]*>([\s\S]*?)<\/a>/gi,
    /href=["'](\/([^/"'#?]+)\/(?:index\.html)?)[^>]*>([\s\S]*?)<\/a>/gi,
  ]

  for (const re of patterns) {
    let m
    while ((m = re.exec(html)) !== null) {
      const rawHref = m[1]
      const showSlug = m[2]
      if (!showSlug || seen.has(showSlug.toLowerCase())) continue
      if (/^(search|css|images|enable-javascript|login|register|contact|about|privacy|dmca|faq|blog|page|tag|category|wp-|assets|static|js|fonts)$/i.test(showSlug)) continue
      if (/^download-\d+$/i.test(showSlug)) continue
      if (/Season-|Episode-/i.test(showSlug)) continue

      let text = String(m[3] || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim()

      if (!text || text.length < 1) {
        text = showSlug.replace(/-otv[a-z0-9]+$/i, '').replace(/^download-/i, '').replace(/-/g, ' ').trim()
      }

      const url = /^https?:\/\//i.test(rawHref)
        ? rawHref
        : `${BASE_URL}/${showSlug}/index.html`

      seen.add(showSlug.toLowerCase())
      shows.push({ showSlug, showName: text, title: text, url, source: 'o2tv' })
    }
  }
  return shows
}

// ═══════════════════════════════════════════════════════════════
// 2. SEASONS — list seasons for a show
// ═══════════════════════════════════════════════════════════════

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
          const abs = /^https?:\/\//i.test(href)
            ? href
            : `${BASE_URL}/${showSlug}/Season-${String(num).padStart(2, '0')}/index.html`
          seasons.push({ number: num, url: abs, label: `Season ${num}` })
        }
      }
    })

    return seasons.sort((a, b) => a.number - b.number)
  } catch (err) {
    console.error('O2TV seasons failed:', err.message)
    return []
  }
}

// ═══════════════════════════════════════════════════════════════
// 3. EPISODES — list episodes for a season
// ═══════════════════════════════════════════════════════════════

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
          const abs = /^https?:\/\//i.test(href)
            ? href
            : `${BASE_URL}/${showSlug}/Season-${String(seasonNum).padStart(2, '0')}/Episode-${String(num).padStart(2, '0')}/index.html`
          episodes.push({ number: num, title: text || `Episode ${num}`, url: abs })
        }
      }
    })

    return episodes.sort((a, b) => a.number - b.number)
  } catch (err) {
    console.error('O2TV episodes failed:', err.message)
    return []
  }
}

// ═══════════════════════════════════════════════════════════════
// 4. RESOLVE — get a playable CDN URL for an episode
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve an episode to a playable CDN URL.
 *
 * Flow:
 *   Episode page → find download link → solve CAPTCHA → get CDN URL
 */
export async function resolveO2TvEpisode(showName, showSlug, seasonNum, epNum) {
  try {
    // Step 1: Get the episode page
    const episodePath = `${showSlug}/Season-${String(seasonNum).padStart(2, '0')}/Episode-${String(epNum).padStart(2, '0')}`
    const html = await fetchPage(`${BASE_URL}/${episodePath}/`)

    // Step 2: Find download file IDs
    const downloadIds = []
    const idRegex = /\/download\/(\d+)/g
    let m
    while ((m = idRegex.exec(html)) !== null) {
      if (!downloadIds.includes(m[1])) downloadIds.push(m[1])
    }

    if (downloadIds.length > 0) {
      // Step 3: Solve captcha to get CDN URL
      try {
        const { resolveViaCaptcha } = await import('./o2tvCaptcha.js')
        const episodeUrl = `${BASE_URL}/${episodePath}/`
        const cdnUrl = await resolveViaCaptcha(episodeUrl)
        if (cdnUrl) {
          const s = String(seasonNum).padStart(2, '0')
          const e = String(epNum).padStart(2, '0')
          return {
            title: `${showName} - S${s}E${e}`,
            url: cdnUrl,
            link: cdnUrl,
            source: 'o2tv',
            isDirect: true,
            playableInRoom: true,
            quality: 'HD',
          }
        }
      } catch (err) {
        console.error('O2TV captcha resolve failed:', err.message)
      }
    }

    // Step 4: Fallback — try direct CDN probe (some episodes work without captcha)
    const cdnHosts = ['d6', 'd2', 'd4', 'd8', 'd1']
    const encodedName = encodeURIComponent(showName)
    const s = String(seasonNum).padStart(2, '0')
    const e = String(epNum).padStart(2, '0')

    for (const host of cdnHosts) {
      const cdnUrl = `http://${host}.o2tv.org/${encodedName}/Season%20${s}/${encodedName}%20-%20S${s}E${e}%20(TvShows4Mobile.Com).mp4`
      const ok = await probeUrl(cdnUrl)
      if (ok) {
        return {
          title: `${showName} - S${s}E${e}`,
          url: cdnUrl,
          link: cdnUrl,
          source: 'o2tv',
          isDirect: true,
          playableInRoom: true,
          quality: 'HD',
        }
      }
    }

    return null
  } catch (err) {
    console.error('O2TV resolve failed:', err.message)
    return null
  }
}

// ─── Probe a URL to check if it works ───
async function probeUrl(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': UA },
      redirect: 'follow',
    })
    clearTimeout(timer)
    return res.ok || res.status === 206
  } catch {
    clearTimeout(timer)
    return false
  }
}

// ─── Fix a broken CDN URL by probing alternatives ───
export async function probeAndFixO2TvUrl(originalUrl) {
  if (await probeUrl(originalUrl)) return originalUrl
  // If the URL doesn't work, try without suffix variations
  try {
    const parsed = new URL(originalUrl)
    const pathParts = parsed.pathname.split('/').filter(Boolean).map(p => decodeURIComponent(p))
    if (pathParts.length < 3) return originalUrl

    const showName = pathParts[0]
    const seasonMatch = pathParts[1]?.match(/Season\s+(\d+)/i)
    const seasonNum = seasonMatch ? parseInt(seasonMatch[1], 10) : 1

    const filename = pathParts[pathParts.length - 1]
    const epMatch = filename.match(/S\d+E(\d+)/i)
    const epNum = epMatch ? parseInt(epMatch[1], 10) : 1

    // Try the base CDN URL without suffix
    const cdnHosts = ['d6', 'd2', 'd4', 'd8', 'd1']
    const encodedName = encodeURIComponent(showName)
    const s = String(seasonNum).padStart(2, '0')
    const e = String(epNum).padStart(2, '0')

    for (const host of cdnHosts) {
      const cdnUrl = `http://${host}.o2tv.org/${encodedName}/Season%20${s}/${encodedName}%20-%20S${s}E${e}%20(TvShows4Mobile.Com).mp4`
      if (await probeUrl(cdnUrl)) return cdnUrl
    }
  } catch { /* */ }

  return originalUrl
}
