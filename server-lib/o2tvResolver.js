/**
 * O2TV Resolver Engine
 *
 * Resolves o2tv/tvshows4mobile URLs by:
 * 1. Searching tvshows4mobile.org for the show
 * 2. Scraping season → episode pages
 * 3. Resolving the /download/{id} → captcha → CDN MP4 chain (via Groq vision)
 *
 * NOTE on CDN suffix probing: the historical `d{N}.o2tv.org/.../otv-XXXXX.mp4`
 * guessing path no longer resolves (every probe 404s as of 2026). The only
 * working MP4 path is the image-captcha resolver in o2tvCaptchaResolver.js,
 * which follows the real /download/{id} links and requires GROQ_API_KEY.
 */

import * as cheerio from 'cheerio'
import { resolveO2TvEpisodeViaCaptcha, suffixCache as captchaSuffixCache } from './o2tvCaptchaResolver.js'

const BASE_URL = 'https://tvshows4mobile.org'
const CDN_HOSTS = ['d6', 'd2', 'd4', 'd8', 'd1']
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const TIMEOUT_MS = 8000
// Full catalog page is ~600KB+; must settle BEFORE the outer 8s race in
// searchDirectLinks, otherwise the fast probeShowPage result gets held hostage
// by Promise.all waiting on the slow catalog → 0 results for the user.
const LIST_TIMEOUT_MS = 6500

// ─── In-memory CDN suffix cache: showKey → { suffix, ts } ───
const suffixCache = captchaSuffixCache  // Shared with o2tvCaptchaResolver
const CACHE_TTL = 4 * 60 * 60 * 1000 // 4 hours

// Catalog cache so repeated Direct searches don't re-download 600KB every time
let catalogCache = { html: '', ts: 0, parsed: null }
const CATALOG_TTL = 30 * 60 * 1000 // 30 minutes

// ─── Fetch HTML from tvshows4mobile.org ───
async function fetchPage(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Parse the full show catalog once (regex — much lighter than cheerio on 600KB).
 * Returns array of { showSlug, showName, url }.
 */
function parseCatalogHtml(html) {
  if (!html) return []
  const shows = []
  const seen = new Set()
  // Absolute + relative show root links
  const patterns = [
    /href=["'](https?:\/\/(?:www\.)?tvshows4mobile\.org\/([^/"'#?]+)\/(?:index\.html)?)["'][^>]*>([\s\S]*?)<\/a>/gi,
    /href=["'](\/([^/"'#?]+)\/(?:index\.html)?)["'][^>]*>([\s\S]*?)<\/a>/gi,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(html)) !== null) {
      const rawHref = m[1]
      const showSlug = m[2]
      if (!showSlug || seen.has(showSlug.toLowerCase())) continue
      // Exclude site chrome paths — but NOT show slugs like "Download-Westworld-otvcjyou"
      // (many older shows use the Download-{Name}-otv{XXX} slug format). Only drop a
      // slug that is EXACTLY a chrome path, not one that merely starts with the word.
      if (/^(search|css|images|enable-javascript|login|register|contact|about|privacy|dmca|faq|blog|page|tag|category|wp-|assets|static|js|fonts)$/i.test(showSlug)) continue
      if (/^download-\d+$/i.test(showSlug)) continue // numeric download-page IDs only
      if (/Season-|Episode-/i.test(showSlug)) continue
      let text = String(m[3] || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
      // Prefer slug-derived name if anchor text is empty / junk
      if (!text || text.length < 1) {
        text = showSlug
          .replace(/-otv[a-z0-9]+$/i, '')
          .replace(/^download-/i, '')
          .replace(/-/g, ' ')
          .trim()
      }
      const url = /^https?:\/\//i.test(rawHref)
        ? rawHref
        : `${BASE_URL}/${showSlug}/index.html`
      seen.add(showSlug.toLowerCase())
      shows.push({
        showSlug,
        showName: text,
        title: text,
        url,
        source: 'o2tv',
      })
    }
  }
  return shows
}

async function getCatalogShows() {
  if (catalogCache.parsed && Date.now() - catalogCache.ts < CATALOG_TTL) {
    return catalogCache.parsed
  }
  const html = await fetchPage(`${BASE_URL}/search/list_all_tv_series`, LIST_TIMEOUT_MS)
  const parsed = parseCatalogHtml(html)
  catalogCache = { html, ts: Date.now(), parsed }
  return parsed
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

function regexEscape(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Split into lowercase word tokens, dropping non-alphanumeric noise.
function toWords(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean)
}

// Strip a single leading article (the/a/an) — so "The Walking Dead" aligns
// with a query of just "Walking Dead". Only strips ONE leading article.
function stripLeadingArticle(words) {
  if (Array.isArray(words) && words.length > 1 && /^(the|a|an)$/.test(words[0])) {
    return words.slice(1)
  }
  return words
}

// Remove ALL articles (the/a/an) from a word list — so "House of the Dragon"
// aligns with "house of dragon" (the user drops the middle "the").
function withoutArticles(words) {
  return (Array.isArray(words) ? words : []).filter((w) => !/^(the|a|an)$/.test(w))
}

// Normalize a show slug for matching: drop the Download- prefix, the -otv{XXX}
// suffix, and any trailing standalone version/season-count number (-8, -9).
function normalizeSlug(slug) {
  return String(slug || '')
    .replace(/^download-/i, '')
    .replace(/-otv[a-z0-9]+$/i, '')
    .replace(/-\d+$/i, '')
    .replace(/-/g, ' ')
    .trim()
}

/**
 * Score how well a catalog show matches the query (0 = no match, higher = better).
 *
 * Uses WORD-based, article-insensitive matching so:
 *   - "walking dead"  -> "The Walking Dead" (98) beats "Fear the Walking Dead" (74)
 *   - "flash"         -> "The Flash" (98)
 *   - "arrow"         -> "Arrow" (100), NOT "Allen v Farrow" (low)
 *
 * The main show (exact word set, fewest extra words) always outranks spinoffs.
 */
function scoreShowMatch(queryRaw, showName, showSlug) {
  const qNorm = normalize(queryRaw)
  const titleNorm = normalize(showName)
  const slugNorm = normalize(normalizeSlug(showSlug))
  if (!qNorm) return 0

  // 100: exact normalized title or slug
  if (titleNorm === qNorm || slugNorm === qNorm) return 100

  // Word-based, article-insensitive comparison (primary signal)
  const qWords = stripLeadingArticle(toWords(queryRaw))
  const tWords = stripLeadingArticle(toWords(showName))
  const sWords = stripLeadingArticle(toWords(normalizeSlug(showSlug)))
  const qJoined = qWords.join(' ')
  const tJoined = tWords.join(' ')
  const sJoined = sWords.join(' ')

  // 98: exact word sequence after stripping leading articles
  //   ("walking dead" == "The Walking Dead" -> [walking,dead] == [walking,dead])
  if (qJoined && (qJoined === tJoined || qJoined === sJoined)) return 98

  // 95: query words are a contiguous PREFIX of the title words (article-stripped)
  if (qJoined && (tJoined.startsWith(qJoined) || sJoined.startsWith(qJoined))) return 95

  // 90: concatenated startsWith (catches compound/spacing quirks)
  if (titleNorm.startsWith(qNorm) || slugNorm.startsWith(qNorm)) return 90

  // 85: query is a contiguous run of words INSIDE the title (same order),
  // article-insensitive (so "house of dragon" matches "House of the Dragon").
  if (qJoined) {
    const qNoArticles = withoutArticles(qWords).join(' ')
    const tNoArticles = withoutArticles(tWords).join(' ')
    const sNoArticles = withoutArticles(sWords).join(' ')
    if (qNoArticles && (tNoArticles.includes(qNoArticles) || sNoArticles.includes(qNoArticles)
      || tJoined.includes(qJoined) || sJoined.includes(qJoined))) {
      const extra = Math.max(tWords.length, sWords.length) - qWords.length
      return Math.max(70, 85 - extra * 4)
    }
  }

  // 80: concatenated includes (fallback)
  if (titleNorm.includes(qNorm) || slugNorm.includes(qNorm)) return 80

  // 60: all significant query tokens (>=3 chars) present somewhere (loose)
  const tokens = qNorm.match(/[a-z0-9]{3,}/g) || []
  if (tokens.length >= 1) {
    const hay = titleNorm + slugNorm
    if (tokens.every((t) => hay.includes(t))) return 60
  }

  return 0
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

  // 4. 2-char systematic suffixes
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < chars.length; i++) {
    for (let j = 0; j < chars.length; j++) {
      candidates.push(`otv-${chars[i]}${chars[j]}`)
      if (candidates.length > 600) break
    }
    if (candidates.length > 600) break
  }

  return candidates
}

// ─── Probe CDN for a working URL (legacy; largely inert post-2026) ───
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

/**
 * Direct show-page probe.
 * The full catalog is ~625KB and can exceed the serverless (Vercel Hobby 10s)
 * wall-clock on cold egress. For a typed show name (e.g. "silo") this tiny
 * ~20KB probe of /{slug}/ is fast and reliable, so searchO2Tv runs it in
 * parallel with the catalog — a valid show never returns zero results.
 */
async function probeShowPage(query) {
  const qRaw = String(query || '').trim()
  const guessSlug = qRaw
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!guessSlug || guessSlug.length < 2) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    const res = await fetch(`${BASE_URL}/${guessSlug}/`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      redirect: 'follow',
    })
    clearTimeout(timer)
    const finalUrl = res.url || ''
    const probe = await res.text()
    const esc = regexEscape(guessSlug)
    const slugInPath = new RegExp(`/${esc}/`, 'i').test(finalUrl)
    const slugInHtml = new RegExp(esc, 'i').test(probe)
    // A real show page has Season-N links, is not a 404, and didn't soft-redirect
    // back to the master catalog list.
    const isShowPage = slugInPath
      && slugInHtml
      && /Season-\d+/i.test(probe)
      && !/404 Page Not Found/i.test(probe)
      && !/list_all_tv_series/i.test(finalUrl)
    if (isShowPage) {
      return {
        title: qRaw,
        showSlug: guessSlug,
        showName: qRaw,
        url: `${BASE_URL}/${guessSlug}/index.html`,
        source: 'o2tv',
        matchScore: 95,
        guessed: true,
      }
    }
  } catch {
    /* no guess */
  }
  return null
}

// ─── Search tvshows4mobile.org for a show ───
export async function searchO2Tv(query, maxResults = 10) {
  const qRaw = String(query || '').trim()
  if (!qRaw) return []
  const qNorm = normalize(qRaw)
  if (!qNorm) return []

  try {
    // Run the (cached) catalog search and the fast direct show-page probe
    // CONCURRENTLY. The probe guarantees an exact-name match returns even when
    // the large catalog fetch is slow or times out on serverless.
    //
    // CRITICAL: Do NOT use Promise.all here — if the catalog is slow (6s+) but
    // the probe is fast (<1s), Promise.all holds the probe hostage until the
    // catalog settles. Instead, race them: use whichever resolves first, then
    // merge the other if it arrives within a short grace period.
    const catalogPromise = getCatalogShows().catch((err) => {
      console.error('O2TV catalog fetch failed:', err.message)
      return []
    })
    const probePromise = probeShowPage(qRaw)

    // Wait up to 2s for the probe (it should be fast — small page fetch)
    const probed = await Promise.race([
      probePromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ])

    // Score whatever catalog results we have so far (may still be pending)
    let catalog = []
    try {
      // Give the catalog a short grace period if it hasn't resolved yet
      catalog = await Promise.race([
        catalogPromise,
        new Promise((resolve) => setTimeout(() => resolve([]), 3000)),
      ])
    } catch {
      catalog = []
    }

    const scored = []
    for (const show of catalog) {
      const matchScore = scoreShowMatch(qRaw, show.showName || show.title, show.showSlug)
      if (matchScore <= 0) continue
      scored.push({
        title: show.showName || show.title,
        showSlug: show.showSlug,
        showName: show.showName || show.title,
        url: show.url || `${BASE_URL}/${show.showSlug}/index.html`,
        source: 'o2tv',
        matchScore,
      })
    }

    // Merge the direct probe result if the catalog didn't already surface it.
    // This is what makes a query like "silo" resolve even on a catalog timeout.
    if (probed && !scored.some((s) => normalize(s.showSlug) === normalize(probed.showSlug))) {
      scored.push(probed)
    }

    // If catalog was still pending and we have zero results, wait a bit more
    if (scored.length === 0) {
      try {
        const lateCatalog = await Promise.race([
          catalogPromise,
          new Promise((resolve) => setTimeout(() => resolve([]), 2000)),
        ])
        for (const show of lateCatalog) {
          const matchScore = scoreShowMatch(qRaw, show.showName || show.title, show.showSlug)
          if (matchScore <= 0) continue
          scored.push({
            title: show.showName || show.title,
            showSlug: show.showSlug,
            showName: show.showName || show.title,
            url: show.url || `${BASE_URL}/${show.showSlug}/index.html`,
            source: 'o2tv',
            matchScore,
          })
        }
      } catch { /* */ }
    }

    scored.sort((a, b) => b.matchScore - a.matchScore || a.title.localeCompare(b.title))

    return scored.slice(0, Math.max(1, Number(maxResults) || 10))
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
          const abs = /^https?:\/\//i.test(href)
            ? href
            : `${BASE_URL}/${showSlug}/Season-${String(num).padStart(2, '0')}/index.html`
          seasons.push({
            number: num,
            url: abs,
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
          const abs = /^https?:\/\//i.test(href)
            ? href
            : `${BASE_URL}/${showSlug}/Season-${String(seasonNum).padStart(2, '0')}/Episode-${String(num).padStart(2, '0')}/index.html`
          episodes.push({
            number: num,
            title: text || `Episode ${num}`,
            url: abs,
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

/**
 * Resolve a single episode to a playable CDN URL.
 * Order: captcha (the only working MP4 path — follows /download/{id}) first,
 * then legacy CDN suffix probing as a no-GROQ fallback.
 */
export async function resolveO2TvEpisode(showName, showSlug, seasonNum, epNum) {
  // 1. Captcha/download-page path first (requires GROQ_API_KEY)
  try {
    const captchaResults = await resolveO2TvEpisodeViaCaptcha(showSlug || showName, seasonNum, epNum)
    if (captchaResults && captchaResults.length && captchaResults[0] && captchaResults[0].url) {
      const r = captchaResults[0]
      const s = String(seasonNum).padStart(2, '0')
      const e = String(epNum).padStart(2, '0')
      return {
        title: r.title || `${showName} - S${s}E${e}`,
        url: r.url,
        link: r.link || r.url,
        source: 'o2tv',
        isDirect: true,
        playableInRoom: r.playableInRoom !== false,
        quality: r.quality || 'MP4',
      }
    }
  } catch (err) {
    console.error('O2TV captcha resolve failed:', err.message)
  }

  // 2. Legacy CDN suffix probing (inert post-2026, kept as a no-GROQ fallback)
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

    const results = []
    for (const season of seasons.slice(0, maxSeasons)) {
      const episodes = await getO2TvEpisodes(show.showSlug, season.number)
      const epsToProcess = episodes.slice(0, maxEpisodes)

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
        const fallbackUrl = buildCdnUrl(CDN_HOSTS[0], showName, season, ep, `otv-${suffix}`)
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

    // Captcha resolution first (the only reliable path)
    try {
      const shows = await searchO2Tv(showName, 3)
      const match = shows.find(s => s.showName.toLowerCase() === showName.toLowerCase()) || shows[0]
      if (match) {
        const captchaResults = await resolveO2TvEpisodeViaCaptcha(match.showSlug, seasonNum, epNum)
        if (captchaResults.length && captchaResults[0].url) return captchaResults[0].url
      }
    } catch { /* keep trying */ }

    // Legacy CDN probe fallback
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
