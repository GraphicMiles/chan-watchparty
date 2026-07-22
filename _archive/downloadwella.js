import * as cheerio from 'cheerio'
import { isSuitableThumbnail } from './sources.js'

const DOWNLOAD_HOST = 'downloadwella.com'
const MEDIA_RE = /\.(mp4|mkv|m3u8|webm|mov|avi|flv|ts)(?:\?|#|$)/i
const MAX_REDIRECTS = 5
const MAX_FORM_STEPS = 4
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
// Hobby-safe probe — previous 6s probes stacked and blew the 10s budget
const PROBE_MS = 2500
const REQUEST_MS = 4000

function isDownloadHost(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return hostname === DOWNLOAD_HOST
      || hostname.endsWith(`.${DOWNLOAD_HOST}`)
      || hostname.includes('downloadwella')
      || hostname.includes('fsmc')
  } catch {
    return false
  }
}

function isAllowedMediaUrl(value) {
  try {
    const parsed = new URL(value)
    if (!['https:', 'http:'].includes(parsed.protocol)) return false
    const hostname = parsed.hostname.toLowerCase()
    const looksLikeMedia = MEDIA_RE.test(parsed.pathname)
      || MEDIA_RE.test(parsed.href)
      || /\/d\/[a-z0-9]+/i.test(parsed.pathname)
      || /\/files?\//i.test(parsed.pathname)
      || /\/cgi-bin\//i.test(parsed.pathname)
    if (!looksLikeMedia) return false
    const isGeneratedFile = hostname === DOWNLOAD_HOST
      || hostname.endsWith(`.${DOWNLOAD_HOST}`)
      || hostname.includes('downloadwella')
      || hostname.includes('fsmc')
      || /\.(mp4|mkv|webm|m3u8)(\?|#|$)/i.test(parsed.pathname)
    return isGeneratedFile
  } catch {
    return false
  }
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
      // Include the clicked submit button name/value when present
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
      .replace(/&amp;/g, '&')
      .replace(/\\u0026/g, '&')
      .replace(/\\\//g, '/')
      .replace(/&#40;|&#41;/g, (match) => (match === '&#40;' ? '(' : ')'))
    try {
      const absolute = new URL(decoded, pageUrl).href
      if (isAllowedMediaUrl(absolute)) urls.add(absolute)
    } catch {
      /* ignore malformed links */
    }
  }

  $('a[href], source[src], video[src], iframe[src]').each((_, element) => {
    add($(element).attr('href') || $(element).attr('src'))
  })

  // data-* attributes often hold generated links after "Create download link"
  $('[data-url], [data-href], [data-link], [data-download]').each((_, element) => {
    add($(element).attr('data-url') || $(element).attr('data-href') || $(element).attr('data-link') || $(element).attr('data-download'))
  })

  const rawMatches = html.match(/https?:[^\s"'<>]+\.(?:mp4|mkv|m3u8|webm|mov|avi|flv|ts)(?:\?[^\s"'<>]*)?/gi) || []
  rawMatches.forEach(add)

  // /d/{token} hotlink pattern (DownloadWella classic)
  const dMatches = html.match(/https?:\/\/[^\s"'<>]*\/d\/[a-z0-9]{8,}[^\s"'<>]*/gi) || []
  dMatches.forEach(add)

  // JS assignments: window.open / location / downloadurl / file_url
  const jsPatterns = [
    /(?:location\.href|window\.location|window\.open|download_url|file_url|direct_link|dllink)\s*=\s*['"](https?:[^'"]+)['"]/gi,
    /(?:href)\s*=\s*['"](https?:[^'"]*\/d\/[a-z0-9]+[^'"]*)['"]/gi,
  ]
  for (const re of jsPatterns) {
    let m
    while ((m = re.exec(html)) !== null) add(m[1])
  }

  return [...urls]
}

function extractPageThumbnail(html, pageUrl) {
  try {
    const $ = cheerio.load(html)
    const candidates = [
      $('meta[property="og:image"]').attr('content'),
      $('meta[name="twitter:image"]').attr('content'),
      $('.poster img, .thumb img, article img, .post-thumbnail img').first().attr('src'),
      $('img[src]').first().attr('src'),
    ]
    for (const raw of candidates) {
      if (!raw) continue
      try {
        const resolved = new URL(raw, pageUrl).href
        if (isSuitableThumbnail(resolved)) return resolved
      } catch {
        /* ignore invalid url */
      }
    }
    return null
  } catch {
    return null
  }
}

async function request(url, options = {}) {
  const { headers = {}, timeoutMs = REQUEST_MS, ...rest } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...rest,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe a candidate media URL. Returns the URL if it looks like video bytes,
 * null if HTML/JSON error page (expired token).
 * On network timeout we still return the URL — player/proxy can re-probe.
 */
async function probeDirectUrl(mediaUrl) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_MS)
    try {
      const res = await fetch(mediaUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          Range: 'bytes=0-1',
          Referer: 'https://downloadwella.com/',
          Origin: 'https://downloadwella.com',
        },
      })
      if (!res.ok && res.status !== 206) {
        // 403/404 with HTML = dead token
        if (res.status === 403 || res.status === 404 || res.status === 410) return null
        return null
      }
      const ct = res.headers.get('content-type') || ''
      if (/text\/html|application\/json|text\/plain/i.test(ct)) return null
      await res.arrayBuffer().catch(() => {})
      return mediaUrl
    } finally {
      clearTimeout(timer)
    }
  } catch {
    // Timeout / network — keep candidate; proxy will surface a clear error if dead
    return mediaUrl
  }
}

async function filterLiveDirectUrls(urls) {
  if (!urls?.length) return []
  // Prefer MP4 over MKV for Chrome; probe top candidates only (Hobby budget)
  const ranked = [...urls].sort((a, b) => {
    const score = (u) => {
      let s = 0
      if (/\.mp4(\?|#|$)/i.test(u)) s += 10
      if (/\.webm(\?|#|$)/i.test(u)) s += 8
      if (/\.m3u8(\?|#|$)/i.test(u)) s += 6
      if (/\.mkv(\?|#|$)/i.test(u)) s -= 3
      if (/hevc|x265|h265/i.test(u)) s -= 8
      return s
    }
    return score(b) - score(a)
  })
  const toProbe = ranked.slice(0, 4)
  const probed = await Promise.all(toProbe.map((u) => probeDirectUrl(u)))
  return probed.filter(Boolean)
}

function pickBestForm($) {
  // Prefer free-download progression forms in order
  const preferredOps = ['download2', 'download1', 'download']
  for (const op of preferredOps) {
    const form = $('form').filter((_, element) => {
      const val = ($(element).find('input[name="op"]').attr('value') || '').toLowerCase()
      return val === op || val.includes(op)
    }).first()
    if (form.length) return form
  }
  // Any form that looks like download
  const form = $('form').filter((_, element) => {
    const op = $(element).find('input[name="op"]').attr('value') || ''
    const id = $(element).attr('id') || ''
    const action = $(element).attr('action') || ''
    const html = $(element).html() || ''
    return /download|create.?link|get.?link|method_free/i.test(`${op} ${id} ${action} ${html}`)
  }).first()
  return form.length ? form : null
}

/**
 * Walk DownloadWella multi-step free-download forms without Puppeteer.
 * Many pages are: landing → download1 (countdown) → download2 → /d/token
 */
async function walkForms(startUrl, startHtml, startCookies, thumbnail) {
  let currentUrl = startUrl
  let html = startHtml
  let cookies = startCookies
  let thumb = thumbnail

  for (let step = 0; step < MAX_FORM_STEPS; step += 1) {
    const fromPage = await filterLiveDirectUrls(directUrlsFromHtml(html, currentUrl))
    if (fromPage.length) {
      return { directUrls: fromPage, thumbnail: thumb, requiresUserAction: false }
    }

    const $ = cheerio.load(html)
    const form = pickBestForm($)
    if (!form) break

    const action = form.attr('action')
      ? new URL(form.attr('action'), currentUrl).href
      : currentUrl

    // Don't POST off-site unless it's already a media URL
    if (!isDownloadHost(action) && !isAllowedMediaUrl(action)) break

    const fields = formFields($, form)
    // Force free path when the form supports it
    if (!fields.has('method_free')) {
      const freeBtn = form.find('input[name="method_free"]').attr('value')
      if (freeBtn) fields.set('method_free', freeBtn)
      else if (/method_free|free download/i.test(form.html() || '')) {
        fields.set('method_free', 'Free Download')
      }
    }
    // Clear premium fields that block free path
    if (fields.has('method_premium') && fields.has('method_free')) {
      fields.delete('method_premium')
    }
    // Common XFileSharing countdown field — set to 0 so server accepts immediately
    if (fields.has('countdown')) fields.set('countdown', '0')
    if (fields.has('adblock_detected')) fields.set('adblock_detected', '0')

    let response
    try {
      response = await request(action, {
        method: 'POST',
        headers: {
          Referer: currentUrl,
          Origin: 'https://downloadwella.com',
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(cookies ? { Cookie: cookies } : {}),
        },
        body: fields.toString(),
      })
    } catch {
      break
    }
    cookies = mergeCookies(cookies, response)

    // Follow redirect chain (may land on /d/ media)
    let hop = 0
    while (response.status >= 300 && response.status < 400 && hop < MAX_REDIRECTS) {
      const location = response.headers.get('location')
      if (!location) break
      const next = new URL(location, action).href
      if (isAllowedMediaUrl(next)) {
        const live = await probeDirectUrl(next)
        if (live) return { directUrls: [live], thumbnail: thumb, requiresUserAction: false }
      }
      if (!isDownloadHost(next) && !isAllowedMediaUrl(next)) break
      try {
        response = await request(next, {
          headers: { Referer: currentUrl, ...(cookies ? { Cookie: cookies } : {}) },
        })
      } catch {
        break
      }
      cookies = mergeCookies(cookies, response)
      currentUrl = next
      hop += 1
    }

    if (!response.ok && response.status !== 200) break
    try {
      html = await response.text()
    } catch {
      break
    }
    currentUrl = response.url || action
    thumb = extractPageThumbnail(html, currentUrl) || thumb

    const after = await filterLiveDirectUrls(directUrlsFromHtml(html, currentUrl))
    if (after.length) {
      return { directUrls: after, thumbnail: thumb, requiresUserAction: false }
    }
  }

  return { directUrls: [], thumbnail: thumb, requiresUserAction: true }
}

export async function resolveDownloadwellaPage(pageUrl) {
  if (!isDownloadHost(pageUrl) && !isAllowedMediaUrl(pageUrl)) {
    return { directUrls: [], thumbnail: null, requiresUserAction: false }
  }

  // Fast path: already a media /d/ link
  if (isAllowedMediaUrl(pageUrl)) {
    const live = await probeDirectUrl(pageUrl)
    if (live) return { directUrls: [live], thumbnail: null, requiresUserAction: false }
    // Dead token — tell caller to re-open Nkiri for a fresh page
    return {
      directUrls: [],
      thumbnail: null,
      requiresUserAction: true,
      expired: true,
      error: 'Download link token expired — re-open the Nkiri episode and resolve again',
    }
  }

  let currentUrl = pageUrl
  let cookies = ''
  let html = ''

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    let response
    try {
      response = await request(currentUrl, {
        headers: { Referer: 'https://downloadwella.com/', ...(cookies ? { Cookie: cookies } : {}) },
      })
    } catch {
      break
    }
    cookies = mergeCookies(cookies, response)

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) break
      const next = new URL(location, currentUrl).href
      if (isAllowedMediaUrl(next)) {
        const live = await probeDirectUrl(next)
        if (live) return { directUrls: [live], thumbnail: null, requiresUserAction: false }
      }
      if (!isDownloadHost(next)) break
      currentUrl = next
      continue
    }

    if (!response.ok) break
    html = await response.text()
    break
  }

  if (!html) {
    return { directUrls: [], thumbnail: null, requiresUserAction: true, error: 'Could not load DownloadWella page' }
  }

  const thumbnail = extractPageThumbnail(html, currentUrl)
  const pageDirectUrls = await filterLiveDirectUrls(directUrlsFromHtml(html, currentUrl))
  if (pageDirectUrls.length) {
    return { directUrls: pageDirectUrls, thumbnail, requiresUserAction: false }
  }

  // Multi-step form walk (replaces Puppeteer "Create download link" click for most XFS hosts)
  const walked = await walkForms(currentUrl, html, cookies, thumbnail)
  if (walked.directUrls.length) return walked

  return {
    directUrls: [],
    thumbnail: walked.thumbnail || thumbnail,
    requiresUserAction: true,
    error: 'Could not auto-create download link (JS countdown or captcha). Re-open Nkiri for a fresh episode link, or try another quality (prefer MP4).',
  }
}
