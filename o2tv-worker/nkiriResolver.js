/**
 * Nkiri + Downloadwella resolver (WORKER COPY).
 * Standalone copy of the relevant parts of server-lib/downloadwella.js +
 * api/media.js Nkiri scraping so the o2tv-worker can resolve Nkiri MKV
 * episodes independently. Keep in sync with the originals.
 *
 * Chain: thenkiri.com show page → downloadwella.com episode link →
 *        walk "Create download" form → direct CDN MKV URL.
 */
import * as cheerio from 'cheerio'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const MEDIA_RE = /\.(mp4|mkv|m3u8|webm|mov|avi|flv|ts)(?:\?|#|$)/i
const MAX_REDIRECTS = 5
const MAX_FORM_STEPS = 6
const REQUEST_MS = 8000
const PROBE_MS = 4000
const COUNTDOWN_MAX_WAIT_MS = 20000 // some XFileSharing pages require waiting out a JS countdown

/**
 * Hosts whose CDN links carry single-use / minutes-lived tokens.
 * A Range probe (or any extra GET) on these consumes or re-validates the
 * token, so we must NEVER probe them — the player's first request must be
 * the real one. Failures are handled by mirror fallback + page re-resolve.
 */
function isTokenHostUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return /downloadwella|fsmc|nkiserv|thenkiri/i.test(hostname)
  } catch {
    return /downloadwella|fsmc|nkiserv|thenkiri/i.test(String(value || ''))
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.headers || {}),
      },
      ...options,
    })
  } finally {
    clearTimeout(timer)
  }
}

function isDownloadHost(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return hostname === 'downloadwella.com' || hostname.endsWith('.downloadwella.com')
      || hostname.includes('downloadwella') || hostname.includes('fsmc')
  } catch { return false }
}

function isAllowedMediaUrl(value) {
  try {
    const parsed = new URL(value)
    if (!['https:', 'http:'].includes(parsed.protocol)) return false
    const hostname = parsed.hostname.toLowerCase()
    const path = parsed.pathname || ''
    // Bare directories / nav paths (e.g. /files/) are never media files.
    if (!path || path === '/' || path.endsWith('/')) return false
    // HTML/PHP/ASP pages are never media files.
    if (/\.(html?|php|aspx?|jsp|shtml)(\?|#|$|\/)/i.test(path)) return false
    const looksLikeMedia = MEDIA_RE.test(path) || MEDIA_RE.test(parsed.href)
      || /\/d\/[a-z0-9]+/i.test(path) || /\/files?\//i.test(path)
    if (!looksLikeMedia) return false
    return hostname === 'downloadwella.com' || hostname.endsWith('.downloadwella.com')
      || hostname.includes('downloadwella') || hostname.includes('fsmc')
      || /\.(mp4|mkv|webm|m3u8)(\?|#|$)/i.test(path)
  } catch { return false }
}

function mergeCookies(previous, response) {
  const jar = new Map()
  for (const part of String(previous || '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name && rest.length) jar.set(name, rest.join('='))
  }
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : String(response.headers.get('set-cookie') || '').split(/,(?=[^;]+=[^;]+)/)
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';')
    const [name, ...rest] = pair.trim().split('=')
    if (name && rest.length) jar.set(name, rest.join('='))
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

function formFields($, form) {
  const fields = new URLSearchParams()
  form.find('input[name], textarea[name], select[name]').each((_, element) => {
    const name = $(element).attr('name')
    if (!name) return
    const type = ($(element).attr('type') || '').toLowerCase()
    if (type === 'submit' || type === 'image' || type === 'button') {
      const value = $(element).attr('value')
      if (value != null && !fields.has(name)) fields.set(name, value)
      return
    }
    if (type === 'checkbox' || type === 'radio') {
      if ($(element).is('[checked]') || $(element).attr('checked') != null) {
        fields.set(name, $(element).attr('value') || '1')
      }
      return
    }
    const value = $(element).attr('value') || $(element).text() || ''
    fields.set(name, value)
  })
  return fields
}

function directUrlsFromHtml(html, pageUrl) {
  const $ = cheerio.load(html)
  const urls = new Set()
  const add = (raw) => {
    if (!raw) return
    const decoded = String(raw)
      .replace(/&amp;/g, '&').replace(/\\u0026/g, '&').replace(/\\\//g, '/')
      .replace(/&#40;|&#41;/g, (m) => (m === '&#40;' ? '(' : ')'))
    try {
      const absolute = new URL(decoded, pageUrl).href
      if (isAllowedMediaUrl(absolute)) urls.add(absolute)
    } catch { /* ignore */ }
  }
  $('a[href], source[src], video[src], iframe[src]').each((_, el) => add($(el).attr('href') || $(el).attr('src')))
  // Media URLs embedded in text/JS. The lookahead stops the regex from matching
  // ".mkv" inside ".mkv.html" (a download PAGE) and the bracket exclusion stops
  // forum-code artifacts like "[URL=…mkv.html]Silo…mkv[/URL]" from being treated
  // as files — those two were returning HTML pages as playable links.
  const rawMatches = html.match(/https?:\/\/[^\s"'<>[\]]+?\.(?:mp4|mkv|m3u8|webm|mov|avi|flv|ts)(?=[\s"'<>[\]#?&]|$)(?:\?[^\s"'<>[\]]*)?/gi) || []
  rawMatches.forEach(add)
  const dMatches = html.match(/https?:\/\/[^\s"'<>[\]]*\/d\/[a-z0-9]{8,}[^\s"'<>[\]]*/gi) || []
  dMatches.forEach(add)
  return [...urls]
}

async function probeDirectUrl(mediaUrl) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_MS)
    try {
      const res = await fetch(mediaUrl, {
        method: 'GET', redirect: 'follow', signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', Range: 'bytes=0-1',
          Referer: 'https://downloadwella.com/', Origin: 'https://downloadwella.com' },
      })
      if (!res.ok && res.status !== 206) return null
      const ct = res.headers.get('content-type') || ''
      if (/text\/html|application\/json|text\/plain/i.test(ct)) return null
      await res.arrayBuffer().catch(() => {})
      return mediaUrl
    } finally { clearTimeout(timer) }
  } catch { return mediaUrl } // timeout/network — keep candidate, proxy will verify
}

/**
 * Verify candidate media URLs WITHOUT touching single-use token hosts.
 * Token-host links pass through unverified (a Range probe would consume the
 * token); everything else gets the usual range probe.
 */
async function verifyCandidates(urls) {
  const list = (urls || []).slice(0, 6)
  const results = await Promise.all(list.map((u) => (
    isTokenHostUrl(u) ? u : probeDirectUrl(u)
  )))
  return results.filter(Boolean)
}

function pickBestForm($) {
  const preferredOps = ['download2', 'download1', 'download']
  for (const op of preferredOps) {
    const form = $('form').filter((_, el) => {
      const val = ($(el).find('input[name="op"]').attr('value') || '').toLowerCase()
      return val === op || val.includes(op)
    }).first()
    if (form.length) return form
  }
  const form = $('form').filter((_, el) => {
    const op = $(el).find('input[name="op"]').attr('value') || ''
    const id = $(el).attr('id') || ''
    const action = $(el).attr('action') || ''
    const html = $(el).html() || ''
    return /download|create.?link|get.?link|method_free/i.test(`${op} ${id} ${action} ${html}`)
  }).first()
  return form.length ? form : null
}

async function walkForms(startUrl, startHtml, startCookies) {
  let currentUrl = startUrl
  let html = startHtml
  let cookies = startCookies
  for (let step = 0; step < MAX_FORM_STEPS; step += 1) {
    const fromPage = directUrlsFromHtml(html, currentUrl)
    if (fromPage.length) {
      const ok = await verifyCandidates(fromPage)
      if (ok.length) return { directUrls: ok }
    }
    const $ = cheerio.load(html)
    const form = pickBestForm($)
    if (!form) break
    const action = form.attr('action') ? new URL(form.attr('action'), currentUrl).href : currentUrl
    if (!isDownloadHost(action) && !isAllowedMediaUrl(action)) break
    const fields = formFields($, form)
    if (!fields.has('method_free')) {
      const freeBtn = form.find('input[name="method_free"]').attr('value')
      if (freeBtn) fields.set('method_free', freeBtn)
      else if (/method_free|free download/i.test(form.html() || '')) fields.set('method_free', 'Free Download')
    }
    if (fields.has('method_premium') && fields.has('method_free')) fields.delete('method_premium')
    if (fields.has('countdown')) fields.set('countdown', '0')
    if (fields.has('adblock_detected')) fields.set('adblock_detected', '0')

    let response
    try {
      response = await fetchWithTimeout(action, {
        method: 'POST',
        headers: { Referer: currentUrl, Origin: 'https://downloadwella.com',
          'Content-Type': 'application/x-www-form-urlencoded', ...(cookies ? { Cookie: cookies } : {}) },
        body: fields.toString(),
      })
    } catch { break }
    cookies = mergeCookies(cookies, response)

    let hop = 0
    while (response.status >= 300 && response.status < 400 && hop < MAX_REDIRECTS) {
      const location = response.headers.get('location')
      if (!location) break
      const next = new URL(location, action).href
      if (isAllowedMediaUrl(next)) {
        if (isTokenHostUrl(next)) return { directUrls: [next] }
        const live = await probeDirectUrl(next)
        if (live) return { directUrls: [live] }
      }
      if (!isDownloadHost(next) && !isAllowedMediaUrl(next)) break
      try {
        response = await fetchWithTimeout(next, { headers: { Referer: currentUrl, ...(cookies ? { Cookie: cookies } : {}) } })
      } catch { break }
      cookies = mergeCookies(cookies, response)
      currentUrl = next
      hop += 1
    }
    if (!response.ok && response.status !== 200) break
    try { html = await response.text() } catch { break }
    currentUrl = response.url || action
    const after = directUrlsFromHtml(html, currentUrl)
    if (after.length) {
      const ok = await verifyCandidates(after)
      if (ok.length) return { directUrls: ok }
    }
    // JS countdown pages: the free link only appears after a timer. Detect a
    // remaining countdown and wait it out instead of giving up, then loop so
    // the freshly rendered form (new rand/fname) is re-read and re-POSTed.
    if (after.length === 0) {
      const waitSec = readCountdownSeconds(html)
      if (waitSec > 0) {
        const waitMs = Math.min(waitSec * 1000 + 500, COUNTDOWN_MAX_WAIT_MS)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
    }
  }
  return { directUrls: [] }
}

/** Parse a JS/HTML countdown (seconds) from an XFileSharing page. */
function readCountdownSeconds(html) {
  if (!html) return 0
  const inputMatch = html.match(/name=["']countdown["'][^>]*value=["'](\d+)["']/i)
  if (inputMatch) return Math.max(0, parseInt(inputMatch[1], 10) || 0)
  const jsMatch = html.match(/var\s+countdown\s*=\s*(\d+)/i)
  if (jsMatch) return Math.max(0, parseInt(jsMatch[1], 10) || 0)
  const textMatch = html.match(/countdown[^0-9]{0,40}(\d+)\s*(?:sec|second)/i)
  if (textMatch) return Math.max(0, parseInt(textMatch[1], 10) || 0)
  return 0
}

/**
 * Resolve a downloadwella episode page → direct CDN MKV URL (form-walk).
 */
/** Boilerplate/social-junk patterns that are never a real synopsis. */
const SYNOPSIS_JUNK = /(download|watch|stream|subscribe|share our website|support us|in order to|for free|click here|register|login|follow us|join our|comment|leave a|rate this|bookmark|spread the word|telegram|whatsapp|facebook|instagram)/i

/** Reject grammar-drill / repeated-sentence junk (e.g. "I have bought a book. I had bought a book."). */
function isRepetitiveJunk(text) {
  const norm = String(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const words = norm.split(' ')
  if (words.length < 12) return false
  const grams = new Set()
  let dup = 0
  for (let i = 0; i < words.length - 3; i += 1) {
    const g = words.slice(i, i + 3).join(' ')
    if (grams.has(g)) dup += 1
    grams.add(g)
  }
  return dup / words.length > 0.08
}

/**
 * Extract a short synopsis from a scraped page's HTML.
 * Prefers the article's first real content paragraph (Nkiri pages carry the
 * actual story there); falls back to og:description / meta description.
 * Boilerplate descriptions like "Download X for free at nkiri.com…" are
 * rejected so we never surface ad copy as the synopsis.
 */
export function extractPageSynopsis(html) {
  if (!html) return null
  const $ = cheerio.load(html)

  const candidates = []
  $('article .entry-content p, article .post-content p, .entry-content p, .post-content p, article p, .post-content p, .entry-content p, p')
    .each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim()
      if (t.length >= 40) candidates.push(t)
    })
  const good = candidates.find((t) => !SYNOPSIS_JUNK.test(t) && !isRepetitiveJunk(t))
  if (good) return good.slice(0, 600)

  const og = $('meta[property="og:description"]').attr('content')
  const name = $('meta[name="description"]').attr('content')
  const meta = (og || name || '').trim()
  if (meta.length >= 40 && !SYNOPSIS_JUNK.test(meta)) return meta.slice(0, 600)
  return null
}

export async function resolveDownloadwellaPage(pageUrl) {
  const target = String(pageUrl || '').trim()
  if (!target) return { directUrls: [], error: 'no URL' }
  if (!/^https?:\/\//i.test(target)) return { directUrls: [], error: 'not an HTTP URL' }

  // Direct media file → hand it straight to the player. Token hosts must NOT
  // be probed (the probe consumes the token); other hosts get a quick check.
  if (isAllowedMediaUrl(target)) {
    if (isTokenHostUrl(target)) return { directUrls: [target] }
    const live = await probeDirectUrl(target)
    if (live) return { directUrls: [live] }
    return { directUrls: [], expired: true, error: 'token expired' }
  }

  // Legacy / non-downloadwella page (e.g. ds2.nkiserv.com episode pages, old
  // site layouts): fetch and extract direct media links embedded in the HTML.
  if (!isDownloadHost(target)) {
    let html = ''
    try {
      const response = await fetchWithTimeout(target)
      if (response.ok) html = await response.text()
    } catch { /* fall through */ }
    if (html) {
      const urls = directUrlsFromHtml(html, target)
      if (urls.length) {
        const ok = await verifyCandidates(urls)
        if (ok.length) return { directUrls: ok, synopsis: extractPageSynopsis(html) }
      }
      const synopsis = extractPageSynopsis(html)
      if (synopsis) return { directUrls: [], synopsis, error: 'no direct media links on this page' }
    }
    return { directUrls: [], error: 'legacy page: no direct media links found' }
  }

  let currentUrl = target
  let cookies = ''
  let html = ''
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    let response
    try {
      response = await fetchWithTimeout(currentUrl, { headers: { Referer: 'https://downloadwella.com/', ...(cookies ? { Cookie: cookies } : {}) } })
    } catch { break }
    cookies = mergeCookies(cookies, response)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) break
      const next = new URL(location, currentUrl).href
      if (isAllowedMediaUrl(next)) {
        if (isTokenHostUrl(next)) return { directUrls: [next] }
        const live = await probeDirectUrl(next)
        if (live) return { directUrls: [live] }
      }
      if (!isDownloadHost(next)) break
      currentUrl = next
      continue
    }
    if (!response.ok) break
    html = await response.text()
    break
  }
  if (!html) return { directUrls: [], error: 'could not load downloadwella page' }
  const pageSynopsis = extractPageSynopsis(html)
  const pageDirect = directUrlsFromHtml(html, currentUrl)
  if (pageDirect.length) {
    const ok = await verifyCandidates(pageDirect)
    if (ok.length) return { directUrls: ok, synopsis: pageSynopsis }
  }
  const walked = await walkForms(currentUrl, html, cookies)
  if (walked.directUrls.length) return { directUrls: walked.directUrls, synopsis: pageSynopsis }
  return { directUrls: [], error: 'could not auto-create download link (JS countdown/captcha)' }
}

/**
 * Derive a clean episode title from a media filename.
 *   "game.of.thrones.s01e01.(NKIRI.COM).garbage.mkv" → "Game Of Thrones S01E01"
 *   "Silo.S03E01.(THENKIRI.COM).mkv"                 → "Silo S03E01"
 * The site markers "(NKIRI…" / "(THENKIRI…" and the anti-hotlink junk after
 * them are never part of the title.
 */
function deriveTitleFromFilename(href) {
  try {
    let name = decodeURIComponent(String(href).split('/').pop() || '')
    name = name.replace(/\.(mp4|mkv|m3u8|webm|avi|mov|flv|ts)$/i, '')
    // Cut from the first site marker onward: "(NKIRI.COM).<random>", "(THENKIRI…)"
    name = name.split(/\((?:nkiri|thenkiri)/i)[0]
    name = name.replace(/[-._+]+/g, ' ').trim()
    if (!name) return 'Episode'
    // Normalize SxxExx to uppercase, then title-case each word.
    name = name.replace(/\b(s\d{1,2})(e\d{1,2})\b/gi, (m, s, e) => s.toUpperCase() + e.toUpperCase())
    return name.replace(/\b\w/g, (l) => l.toUpperCase())
  } catch {
    return 'Episode'
  }
}

/**
 * Fetch a Nkiri show page and extract ranked downloadwella episode links.
 * Returns [{ url, title, container }].
 */
export async function getNkiriEpisodes(showUrl) {
  const res = await fetchWithTimeout(showUrl, { headers: { Referer: 'https://thenkiri.com/' } })
  if (!res.ok) return []
  const pageHtml = await res.text()
  const $ = cheerio.load(pageHtml)
  const episodes = []
  const seen = new Set()
  const addEp = (hrefRaw, textRaw, force = false) => {
    if (!hrefRaw) return
    let href = String(hrefRaw).replace(/&amp;/g, '&').trim()
    try { href = new URL(href, showUrl).href } catch { return }
    // Legacy/Nkiri-direct pages embed real media files (ds2.nkiserv.com .mkv)
    // — collect ANY direct media URL, not just downloadwella/fsmc links.
    if (!force && !/downloadwella\.com|fsmc/i.test(href) && !MEDIA_RE.test(href)) return
    if (seen.has(href)) return
    seen.add(href)
    let text = String(textRaw || '').replace(/\s+/g, ' ').trim()
    // Useless anchor text ("Download Episode", "Click here", "Continue
    // Reading") → derive a real title from the URL filename instead.
    if (!text || /^(download|click here|continue reading|download episode|watch now|view|link|episode download)/i.test(text) || text.length < 3) {
      text = deriveTitleFromFilename(href)
    }
    const isDirectMedia = MEDIA_RE.test(href)
    episodes.push({
      url: href,
      title: text,
      container: /\.mkv(\?|#|$)/i.test(href) ? 'mkv' : (/\.mp4(\?|#|$)/i.test(href) ? 'mp4' : (/\.m3u8(\?|#|$)/i.test(href) ? 'hls' : (/\.(webm|avi|mov|flv|ts)(\?|#|$)/i.test(href) ? 'other' : 'unknown'))),
      // Direct media files play WITHOUT the downloadwella form-walk.
      isDirectMedia,
    })
  }
  // 1) Anchor links (downloadwella pages OR direct media files)
  $('a[href*="downloadwella.com"], a[href*="fsmc"], a[href*=".mkv"], a[href*=".mp4"], a[href*=".m3u8"], a[href*=".webm"], a[href*=".avi"], a[href*=".mov"], a[href*=".flv"], a[href*=".ts"]').each((_, el) => addEp($(el).attr('href'), $(el).text() || $(el).attr('title')))
  // 2) media elements (video/source/iframe)
  $('video[src], source[src], iframe[src]').each((_, el) => addEp($(el).attr('src'), null, true))
  // 3) Regex fallback for any downloadwella links OR raw media URLs missed by the DOM
  if (episodes.length === 0) {
    const patterns = [
      /href=["'](https?:\/\/[^"']+(?:downloadwella\.com|fsmc)[^"']+)["']/gi,
      /https?:[^\s"'<>]+\.(?:mp4|mkv|m3u8|webm|avi|mov|flv|ts)(?:\?[^\s"'<>]*)?/gi,
    ]
    for (const re of patterns) {
      let m
      while ((m = re.exec(pageHtml)) !== null) addEp(m[1] || m[0], null, true)
    }
  }
  // Prefer MP4 first (Chrome-native), MKV after (needs remux), then others
  episodes.sort((a, b) => {
    const score = (e) => (e.container === 'mp4' ? 10 : e.container === 'mkv' ? 0 : e.container === 'hls' ? 5 : 1)
    return score(b) - score(a)
  })
  // Attach the show page synopsis (arrays are objects — additive, invisible
  // to .map/.filter/.length callers, safe for the worker deploy too).
  episodes.synopsis = extractPageSynopsis(pageHtml)
  return episodes
}

/**
 * Search thenkiri.com for a show, return [{ title, url }].
 */
export async function searchNkiri(query) {
  const q = String(query || '').trim()
  if (!q) return []
  const searchUrl = `https://thenkiri.com/?s=${encodeURIComponent(q)}`
  const res = await fetchWithTimeout(searchUrl, { headers: { Referer: 'https://thenkiri.com/' } })
  if (!res.ok) return []
  const html = await res.text()
  const $ = cheerio.load(html)
  const shows = []
  const seen = new Set()
  const push = (href, title) => {
    if (!href) return
    try { href = new URL(href, searchUrl).href } catch { return }
    if (!/thenkiri\.com|nkiri\.com/i.test(href)) return
    if (/(page|category|tag|search|author|wp-json|feed|wp-content|wp-includes|comments|how-to-download|login|register)\/?/i.test(href)) return
    if (seen.has(href)) return
    seen.add(href)
    shows.push({ title: String(title || '').trim() || href.split('/').filter(Boolean).pop().replace(/[-_]/g, ' '), url: href })
  }
  const selectors = ['.search-entry-inner a[href]', '.search-entry a[href]', 'article a[href]', '.post-item a[href]', '.post a[href]', '.entry-title a[href]', 'h2 a[href]', 'h3 a[href]', 'a[rel="bookmark"]', 'main a[href]']
  for (const sel of selectors) {
    $(sel).each((_, el) => push($(el).attr('href'), $(el).text() || $(el).attr('title')))
  }
  if (shows.length < 3) {
    const re = /href=["'](https?:\/\/(?:www\.)?(?:thenkiri|nkiri)\.com\/[^"']+)["']/gi
    let m
    while ((m = re.exec(html)) !== null) push(m[1], null)
  }
  // Dedup + rank: title containing query first
  const ql = q.toLowerCase()
  shows.sort((a, b) => {
    const ai = a.title.toLowerCase().includes(ql) ? 0 : 1
    const bi = b.title.toLowerCase().includes(ql) ? 0 : 1
    return ai - bi
  })
  return shows.slice(0, 10)
}

// ────────────────────────────────────────────────────────────────────────────
// Phase A: stream descriptors — sniff real bytes, never guess.
// ────────────────────────────────────────────────────────────────────────────

/** Sniff container + codec from the first bytes of a media file. */
export function sniffMedia(bytes) {
  const out = { container: null, codec: null }
  if (!bytes || bytes.length < 16) return out

  if (bytes.subarray(4, 8).toString('latin1') === 'ftyp') out.container = 'mp4'
  else if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) out.container = 'mkv'
  else if (bytes.subarray(0, 4).toString('latin1') === 'RIFF') out.container = 'avi'
  else if (bytes.subarray(0, 4).toString('latin1') === 'OggS') out.container = 'ogg'
  else if (bytes.subarray(0, 4).toString('latin1') === 'FLV\x01') out.container = 'flv'
  else if (bytes.toString('latin1', 4, 8) === 'ftyp') out.container = 'mp4'

  const hay = bytes.toString('latin1') // latin1 = byte-preserving for ascii token scan
  const mkvCodecs = [
    ['V_MPEGH/ISO/HEVC', 'hevc'], ['V_MPEG4/ISO/AVC', 'avc'], ['V_VP9', 'vp9'],
    ['V_AV1', 'av1'], ['V_VP8', 'vp8'], ['V_MPEG4/ISO/ASP', 'mpeg4'],
    ['A_AAC', 'aac'], ['A_OPUS', 'opus'], ['A_AC3', 'ac3'], ['A_EAC3', 'eac3'], ['A_FLAC', 'flac'],
  ]
  for (const [token, id] of mkvCodecs) {
    if (hay.includes(token)) out.codec = out.codec ? `${out.codec}+${id}` : id
  }
  if (out.container === 'mp4' && !out.codec) {
    const mp4Codecs = [
      ['avc1', 'avc'], ['hvc1', 'hevc'], ['hev1', 'hevc'], ['vp09', 'vp9'],
      ['av01', 'av1'], ['mp4a', 'aac'], ['Opus', 'opus'], ['ec-3', 'eac3'], ['ac-3', 'ac3'],
    ]
    for (const [token, id] of mp4Codecs) {
      if (hay.includes(token)) out.codec = out.codec ? `${out.codec}+${id}` : id
    }
  }
  return out
}

/** Full probe of a media URL: range fetch + sniff. Never follows to HTML. */
export async function probeStream(mediaUrl, referer = 'https://downloadwella.com/') {
  const result = {
    ok: false, url: mediaUrl, httpStatus: null, contentType: null,
    ranged: false, sizeBytes: null, container: null, codec: null, error: null,
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_MS)
    const res = await fetch(mediaUrl, {
      method: 'GET', redirect: 'follow', signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT, Accept: '*/*', Range: 'bytes=0-524287',
        Referer: referer, Origin: 'https://downloadwella.com',
      },
    })
    clearTimeout(timer)
    result.httpStatus = res.status
    if (!res.ok && res.status !== 206) {
      result.error = `HTTP ${res.status}`
      return result
    }
    const ct = res.headers.get('content-type') || ''
    result.contentType = ct
    result.ranged = res.status === 206
    const cr = res.headers.get('content-range')
    if (cr) {
      const m = cr.match(/\/(\d+)$/)
      if (m) result.sizeBytes = Number(m[1])
    }
    if (/text\/html|application\/json|text\/plain/i.test(ct)) {
      result.error = 'not media (HTML/JSON)'
      return result
    }
    const buf = await res.arrayBuffer()
    const sniffed = sniffMedia(Buffer.from(buf.slice(0, 524288)))
    result.container = sniffed.container
    result.codec = sniffed.codec
    result.ok = Boolean(sniffed.container || /^video\//i.test(ct) || /octet-stream/i.test(ct))
    return result
  } catch (err) {
    result.error = err?.name === 'AbortError' ? 'timeout' : String(err?.message || 'network error')
    return result
  }
}

/**
 * Build a stream descriptor from candidate direct URLs.
 * The descriptor is the single source of truth for the player: which URL to
 * open, with which headers, what codec/container, and how to refresh it.
 */
export async function buildStreamDescriptor({ streamUrls, sourceUrl, title, referer, synopsis = null, skipProbe = false }) {
  const list = (streamUrls || []).filter(Boolean)
  const primary = list[0] || null
  // A Range GET here consumes one-shot DownloadWella tokens before the
  // player starts. Callers on the create/play path must skipProbe.
  const probe = (!skipProbe && primary) ? await probeStream(primary, referer) : null

  let container = probe?.container || null
  if (!container && primary) {
    container = /\.mkv(\?|#|$)/i.test(primary) ? 'mkv'
      : /\.mp4(\?|#|$)/i.test(primary) ? 'mp4'
        : /\.m3u8(\?|#|$)/i.test(primary) ? 'hls'
          : 'unknown'
  }

  return {
    streamUrl: primary,
    mirrors: list.slice(1),
    referer,
    headers: { 'User-Agent': USER_AGENT, Referer: referer },
    container,
    codec: probe?.codec || null,
    sizeBytes: probe?.sizeBytes || null,
    sourceUrl,
    title: title || null,
    synopsis: synopsis || null,
    probe: {
      ok: probe?.ok === true,
      httpStatus: probe?.httpStatus ?? null,
      contentType: probe?.contentType ?? null,
      ranged: probe?.ranged ?? false,
      error: probe?.error ?? null,
    },
    resolvedAt: Date.now(),
  }
}
