/**
 * O2TV Captcha Resolver (WORKER COPY)
 *
 * This is a standalone copy of server-lib/o2tvCaptchaResolver.js so the
 * o2tv-worker can deploy independently on Railway/Render/etc. without the
 * parent repo. Keep in sync with the original when the resolve chain changes.
 *
 * Resolves o2tv CDN URLs by:
 * 1. Following the download page → captcha page flow
 * 2. Solving the captcha using Groq vision API
 * 3. Following the redirect to the actual CDN URL
 *
 * IMPORTANT (2026): tvshows4mobile serves an interstitial AD on the first
 * captcha solve per session; the SECOND solve (same validated session) yields
 * the real CDN URL with the per-file suffix (otv-XXXXX).
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
const VISION_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'llama-3.2-90b-vision-preview',
  'llama-3.2-11b-vision-preview',
]

export const suffixCache = new Map()
const CACHE_TTL = 4 * 60 * 60 * 1000 // 4 hours

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(timer)
    return res
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

class CookieJar {
  constructor() { this.store = new Map() }
  capture(res) {
    for (const sc of (res.headers.getSetCookie?.() || [])) {
      const pair = sc.split(';')[0]
      const eq = pair.indexOf('=')
      if (eq > 0) this.store.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }
  header() { return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join('; ') }
}

function normalizeMediaUrl(rawUrl) {
  if (!rawUrl) return rawUrl
  try { return new URL(rawUrl).toString() }
  catch { return String(rawUrl).replace(/ /g, '%20') }
}

function isInterstitialAd(url) {
  return /obqj|aliexpress|s\.click|rtmark|partitial|propeller/i.test(url || '')
}

async function solveCaptchaWithGroq(imageBuffer) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured — cannot solve captcha')
  const base64 = imageBuffer.toString('base64')
  const dataUrl = `data:image/png;base64,${base64}`
  let lastError = null
  for (const model of VISION_MODELS) {
    try {
      const res = await fetchWithTimeout(GROQ_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'Read the text in this captcha image. Reply with ONLY the exact text characters shown, no explanation, no quotes, no extra words. Just the text.' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          }],
          max_tokens: 20,
          temperature: 0.1,
        }),
      }, 15000)
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        lastError = new Error(err.error?.message || `Groq API returned HTTP ${res.status}`)
        continue
      }
      const data = await res.json()
      const text = data.choices?.[0]?.message?.content?.trim() || ''
      const cleaned = text.replace(/[^a-zA-Z0-9]/g, '').trim()
      if (cleaned.length >= 3) return cleaned
      lastError = new Error('Empty/short captcha answer from ' + model)
    } catch (err) { lastError = err }
  }
  throw lastError || new Error('All Groq vision models failed')
}

async function solveAndPost(jar, fileId) {
  const BASE = 'https://tvshows4mobile.org'
  const dlRes = await fetchWithTimeout(`${BASE}/download/${fileId}`, {
    redirect: 'manual',
    headers: { 'User-Agent': USER_AGENT, Cookie: jar.header(), Accept: 'text/html' },
  }, 8000)
  jar.capture(dlRes)

  const captchaPageUrl = dlRes.headers.get('location') || `${BASE}/areyouhuman.php?fid=${fileId}`
  const capRes = await fetchWithTimeout(captchaPageUrl, {
    headers: { 'User-Agent': USER_AGENT, Cookie: jar.header(), Referer: `${BASE}/download/${fileId}` },
  }, 8000)
  jar.capture(capRes)
  await capRes.text()

  const imgRes = await fetchWithTimeout(`${BASE}/simplecaptcha1/simple-php-captcha.php?_CAPTCHA&t=${Date.now()}`, {
    headers: { 'User-Agent': USER_AGENT, Cookie: jar.header(), Referer: captchaPageUrl },
  }, 8000)
  jar.capture(imgRes)
  const contentType = imgRes.headers.get('content-type') || ''
  if (!contentType.includes('image')) throw new Error('Captcha image not received — got ' + contentType)
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer())

  let captchaAnswer = ''
  for (let attempt = 0; attempt < 4 && !(captchaAnswer && captchaAnswer.length >= 3); attempt++) {
    try { captchaAnswer = await solveCaptchaWithGroq(imgBuffer) }
    catch (err) { console.error(`Captcha solve attempt ${attempt + 1} failed:`, err.message) }
  }
  if (!captchaAnswer || captchaAnswer.length < 3) throw new Error('Failed to solve captcha after multiple attempts')

  const postRes = await fetchWithTimeout(captchaPageUrl, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Cookie: jar.header(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: captchaPageUrl,
      Origin: BASE,
    },
    body: `captchainput=${encodeURIComponent(captchaAnswer)}&submit=Continue+Download`,
    redirect: 'manual',
  }, 8000)
  jar.capture(postRes)

  const location = postRes.headers.get('location') || ''
  if (!location) {
    const body = await postRes.text().catch(() => '')
    if (/does not match|incorrect|invalid captcha/i.test(body)) throw new Error('Captcha answer was incorrect')
  }
  return location
}

export async function resolveO2TvCaptcha(fileId) {
  const jar = new CookieJar()
  let location = await solveAndPost(jar, fileId).catch((err) => {
    console.error(`solveAndPost #1 failed for ${fileId}:`, err.message)
    return ''
  })
  if (isInterstitialAd(location) || !location) {
    location = await solveAndPost(jar, fileId).catch((err) => {
      console.error(`solveAndPost #2 failed for ${fileId}:`, err.message)
      return ''
    })
  }
  if (!location) return null
  if (/\.(mp4|mkv|m3u8|webm)(\?|#|$)/i.test(location) || /o2tv\.org/i.test(location)) {
    return normalizeMediaUrl(location)
  }
  if (isInterstitialAd(location)) return null

  let currentUrl = location
  for (let i = 0; i < 5 && currentUrl; i++) {
    if (currentUrl.startsWith('/')) currentUrl = `https://tvshows4mobile.org${currentUrl}`
    if (/\.(mp4|mkv|m3u8|webm)(\?|#|$)/i.test(currentUrl) || /o2tv\.org/i.test(currentUrl)) {
      return normalizeMediaUrl(currentUrl)
    }
    try {
      const redirRes = await fetchWithTimeout(currentUrl, {
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, Cookie: jar.header(), Referer: 'https://tvshows4mobile.org/' },
      }, 8000)
      jar.capture(redirRes)
      const next = redirRes.headers.get('location')
      if (!next) {
        if (redirRes.ok) {
          const body = await redirRes.text().catch(() => '')
          const mediaMatch = body.match(/https?:\/\/[^\s"'<>]+\.(mp4|mkv|m3u8|webm)([^\s"'<>]*)?/i)
          if (mediaMatch) return normalizeMediaUrl(mediaMatch[0])
        }
        break
      }
      currentUrl = next
    } catch { break }
  }
  return null
}

function classifyO2TvDownload(label, context = '') {
  const text = `${label || ''} ${context || ''}`.toLowerCase()
  if (/\b3gp\b/.test(text) || /lowest quality|smallest size/.test(text)) {
    return { tier: '3gp', rank: 3, quality: '3gp' }
  }
  if (/\bhd\b/.test(text) || /highest quality|largest size/.test(text)) {
    return { tier: 'hd', rank: 2, quality: 'HD' }
  }
  if (/\bmp4\b/.test(text) || /basic quality|small size/.test(text) || /in mp4 format/.test(text)) {
    if (!/\bhd\b/.test(text) && !/\b3gp\b/.test(text)) return { tier: 'basic', rank: 0, quality: 'MP4' }
  }
  return { tier: 'unknown', rank: 1, quality: 'MP4' }
}

function parseO2TvDownloadOptions(epHtml) {
  const options = []
  const seen = new Set()
  const anchorRe = /href=["'](?:https?:\/\/(?:www\.)?tvshows4mobile\.org)?\/download\/(\d+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = anchorRe.exec(epHtml)) !== null) {
    const id = parseInt(m[1], 10)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const label = String(m[2] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const context = epHtml.slice(Math.max(0, m.index - 280), Math.min(epHtml.length, m.index + 120))
    const classified = classifyO2TvDownload(label, context)
    options.push({ fileId: id, label: label || `Download ${id}`, ...classified })
  }
  if (!options.length) {
    const idRe = /\/download\/(\d+)/g
    let im
    while ((im = idRe.exec(epHtml)) !== null) {
      const id = parseInt(im[1], 10)
      if (!id || seen.has(id)) continue
      seen.add(id)
      options.push({ fileId: id, label: `Download ${id}`, tier: 'unknown', rank: 1, quality: 'MP4' })
    }
  }
  options.sort((a, b) => a.rank - b.rank || a.fileId - b.fileId)
  return options
}

export async function resolveO2TvEpisodeViaCaptcha(showSlug, seasonNum, epNum) {
  const BASE = 'https://tvshows4mobile.org'
  const seasonPath = `Season-${String(seasonNum).padStart(2, '0')}`
  const episodePath = `Episode-${String(epNum).padStart(2, '0')}`
  const episodeUrl = `${BASE}/${showSlug}/${seasonPath}/${episodePath}/`

  const epRes = await fetchWithTimeout(episodeUrl, { headers: { 'User-Agent': USER_AGENT } }, 8000)
  if (!epRes.ok) return []
  const epHtml = await epRes.text()
  const options = parseO2TvDownloadOptions(epHtml)
  if (!options.length) return []

  const showName = showSlug.replace(/^download-/i, '').replace(/-otv[a-z0-9]+$/i, '').replace(/-/g, ' ').trim()
  const s = String(seasonNum).padStart(2, '0')
  const e = String(epNum).padStart(2, '0')
  const title = `${showName} - S${s}E${e}`

  console.log(`O2TV quality order for ${showSlug} S${s}E${e}:`, options.map((o) => `${o.fileId}:${o.tier}`).join(' → '))

  for (const opt of options) {
    try {
      const cdnUrl = await resolveO2TvCaptcha(opt.fileId)
      if (cdnUrl) {
        const suffixMatch = cdnUrl.match(/otv-([a-z0-9]+)/i)
        if (suffixMatch) {
          suffixCache.set(`${showName}|S${s}E${e}`, { suffix: `otv-${suffixMatch[1]}`, ts: Date.now() })
        }
        return [{
          title, url: cdnUrl, link: cdnUrl, source: 'o2tv',
          isDirect: true, playableInRoom: /\.(mp4|webm|m3u8)/i.test(cdnUrl),
          quality: opt.quality || 'MP4', qualityTier: opt.tier, resolvedFileId: opt.fileId,
        }]
      }
    } catch (err) {
      console.error(`Captcha resolution failed for file ${opt.fileId} (${opt.tier}):`, err.message)
    }
  }
  return []
}
