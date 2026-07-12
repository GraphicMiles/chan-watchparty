/**
 * Media helpers (1 Vercel function).
 *
 * POST /api/media
 * body:
 *   { action: 'search', query, sources?: ['youtube'], maxResults?: number }
 *   { action: 'scrape', url, site, roomId? }
 *
 * Note: scrape extracts public list metadata (title/poster/link), not raw stream URLs.
 */
import { getDb, FieldValue } from './lib/firebaseAdmin.js'
import { preflight, ok, fail, statusForError } from './lib/http.js'
import { scraper } from './lib/scraper.js'

async function searchYoutube(query, maxResults = 10) {
  const key = process.env.YOUTUBE_API_KEY || process.env.VITE_YOUTUBE_API_KEY
  if (!key) throw new Error('YouTube API key not configured on server (YOUTUBE_API_KEY)')

  const url =
    `https://www.googleapis.com/youtube/v3/search?` +
    `part=snippet&type=video&maxResults=${Math.min(Math.max(Number(maxResults) || 10, 1), 25)}` +
    `&q=${encodeURIComponent(query)}&key=${key}`

  const res = await fetch(url)
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data?.error?.message || `YouTube search failed (${res.status})`)
  }

  return (data.items || []).map((item) => ({
    source: 'youtube',
    id: item.id?.videoId,
    title: item.snippet?.title,
    thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url,
    channel: item.snippet?.channelTitle,
    publishedAt: item.snippet?.publishedAt,
  })).filter((r) => r.id)
}

async function actionSearch(body) {
  const query = String(body.query || '').trim()
  if (!query) throw new Error('Query required')
  const sources = Array.isArray(body.sources) && body.sources.length ? body.sources : ['youtube']
  const maxResults = body.maxResults || 10

  const results = []
  if (sources.includes('youtube')) {
    results.push(...(await searchYoutube(query, maxResults)))
  }

  return {
    success: true,
    query,
    count: results.length,
    results,
  }
}

async function actionScrape(body) {
  const url = String(body.url || '').trim()
  const site = String(body.site || '').trim().toLowerCase()
  const roomId = body.roomId || null

  if (!url || !site) throw new Error('url and site required')
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid url')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http(s) URLs are allowed')
  }

  const config = scraper.getSiteConfig(site)
  if (!config) throw new Error(`Unknown site config: ${site}`)

  const html = await scraper.fetchHTML(url)
  const $ = scraper.load(html)
  let results = scraper.parseList($, config).map((item) => ({
    ...item,
    link: scraper.absoluteUrl(url, item.link),
    poster: scraper.absoluteUrl(url, item.poster),
    site,
    sourceUrl: url,
  }))

  // Deduplicate by title+link
  const seen = new Set()
  results = results.filter((r) => {
    const key = `${r.title}|${r.link}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  if (roomId && results.length > 0) {
    const db = getDb()
    const scrapeRef = db.collection('scrapes').doc()
    await scrapeRef.set({
      roomId,
      url,
      site,
      results: results.slice(0, 50),
      resultCount: results.length,
      createdAt: FieldValue.serverTimestamp(),
    })
  }

  return {
    success: true,
    count: results.length,
    results: results.slice(0, 20),
  }
}

export default async function handler(req, res) {
  try {
    if (preflight(req, res, { methods: ['POST'] })) return

    const body = req.body || {}
    const action = String(body.action || '').toLowerCase()
    if (!action) return fail(res, 400, 'Missing action (search | scrape)')

    let result
    if (action === 'search') result = await actionSearch(body)
    else if (action === 'scrape') result = await actionScrape(body)
    else return fail(res, 400, `Unknown action: ${action}`)

    return ok(res, result)
  } catch (err) {
    console.error('media API error', err)
    return fail(res, statusForError(err), err.message || 'Internal error')
  }
}
