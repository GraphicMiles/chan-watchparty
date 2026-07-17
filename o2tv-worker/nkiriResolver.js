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
const MAX_FORM_STEPS = 4
const REQUEST_MS = 8000
const PROBE_MS = 4000

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
    const looksLikeMedia = MEDIA_RE.test(parsed.pathname) || MEDIA_RE.test(parsed.href)
      || /\/d\/[a-z0-9]+/i.test(parsed.pathname) || /\/files?\//i.test(parsed.pathname)
    if (!looksLikeMedia) return false
    return hostname === 'downloadwella.com' || hostname.endsWith('.downloadwella.com')
      || hostname.includes('downloadwella') || hostname.includes('fsmc')
      || /\.(mp4|mkv|webm|m3u8)(\?|#|$)/i.test(parsed.pathname)
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
  const rawMatches = html.match(/https?:[^\s"'<>]+\.(?:mp4|mkv|m3u8|webm|mov|avi|flv|ts)(?:\?[^\s"'<>]*)?/gi) || []
  rawMatches.forEach(add)
  const dMatches = html.match(/https?:\/\/[^\s"'<>]*\/d\/[a-z0-9]{8,}[^\s"'<>]*/gi) || []
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
      const live = await Promise.all(fromPage.slice(0, 3).map(probeDirectUrl))
      const ok = live.filter(Boolean)
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
      const live = await Promise.all(after.slice(0, 3).map(probeDirectUrl))
      const ok = live.filter(Boolean)
      if (ok.length) return { directUrls: ok }
    }
  }
  return { directUrls: [] }
}

/**
 * Resolve a downloadwella episode page → direct CDN MKV URL (form-walk).
 */
export async function resolveDownloadwellaPage(pageUrl) {
  if (!isDownloadHost(pageUrl) && !isAllowedMediaUrl(pageUrl)) return { directUrls: [], error: 'not a downloadwella URL' }
  if (isAllowedMediaUrl(pageUrl)) {
    const live = await probeDirectUrl(pageUrl)
    if (live) return { directUrls: [live] }
    return { directUrls: [], expired: true, error: 'token expired' }
  }
  let currentUrl = pageUrl
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
  const pageDirect = directUrlsFromHtml(html, currentUrl)
  if (pageDirect.length) {
    const live = await Promise.all(pageDirect.slice(0, 3).map(probeDirectUrl))
    const ok = live.filter(Boolean)
    if (ok.length) return { directUrls: ok }
  }
  const walked = await walkForms(currentUrl, html, cookies)
  if (walked.directUrls.length) return { directUrls: walked.directUrls }
  return { directUrls: [], error: 'could not auto-create download link (JS countdown/captcha)' }
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
  const addEp = (hrefRaw, textRaw) => {
    if (!hrefRaw) return
    let href = String(hrefRaw).replace(/&amp;/g, '&').trim()
    try { href = new URL(href, showUrl).href } catch { return }
    if (!/downloadwella\.com|fsmc/i.test(href)) return
    if (seen.has(href)) return
    seen.add(href)
    let text = String(textRaw || '').replace(/\s+/g, ' ').trim()
    if (!text) {
      const urlMatch = href.match(/\/([^/]+)\.html?$/i)
      text = urlMatch ? urlMatch[1].replace(/[-._+]/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()) : 'Episode'
    }
    episodes.push({ url: href, title: text, container: /\.mkv/i.test(href) ? 'mkv' : (/\.mp4/i.test(href) ? 'mp4' : 'unknown') })
  }
  $('a[href*="downloadwella.com"], a[href*="fsmc"]').each((_, el) => addEp($(el).attr('href'), $(el).text() || $(el).attr('title')))
  // Regex fallback for any downloadwella links missed by the DOM
  if (!episodes.length) {
    const patterns = [
      /href=["'](https?:\/\/(?:www\.)?downloadwella\.com\/[^"']+)["']/gi,
      /["'](https?:\/\/(?:www\.)?downloadwella\.com\/[^"'\s]+)["']/gi,
    ]
    for (const re of patterns) {
      let m
      while ((m = re.exec(pageHtml)) !== null) addEp(m[1].replace(/&amp;/g, '&'), null)
    }
  }
  // Prefer MP4 first (Chrome-native), MKV after (needs remux)
  episodes.sort((a, b) => {
    const score = (e) => (e.container === 'mp4' ? 10 : e.container === 'mkv' ? 0 : 1)
    return score(b) - score(a)
  })
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
