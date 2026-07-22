/**
 * O2TV Captcha Resolver
 *
 * Resolves o2tv CDN URLs by:
 * 1. Following the download page → captcha page flow
 * 2. Solving the captcha using Groq vision API
 * 3. Following the redirect to the actual CDN URL
 *
 * IMPORTANT (2026): tvshows4mobile serves an interstitial AD on the first
 * captcha solve per session; the SECOND solve (same validated session) yields
 * the real CDN URL with the per-file suffix (otv-XXXXX). The suffixes are not
 * guessable, so the captcha path is the only working MP4 resolution route.
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
// Groq has decommissioned earlier vision models (llama-3.2-*-vision-preview).
// Try these multimodal models in order; the first that accepts image input wins.
const VISION_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'llama-3.2-90b-vision-preview',
  'llama-3.2-11b-vision-preview',
]

// ─── Suffix cache shared with o2tvResolver.js ───
export const suffixCache = new Map()
const CACHE_TTL = 4 * 60 * 60 * 1000 // 4 hours

const CDN_HOSTS = ['d6', 'd2', 'd4', 'd8', 'd1']
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ─── Fetch with timeout ───
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

// ─── Proper cookie jar ───
// Naive "join('; ')" concatenation creates DUPLICATE PHPSESSID entries after the
// POST re-sets the session — the server then reads the stale (unverified) value
// and re-triggers the captcha. We store by name so re-sets replace cleanly.
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

// Encode a raw Location header (may contain literal spaces) into a valid URL.
// The URL constructor already percent-encodes spaces in the pathname, so we just
// re-serialize — do NOT call encodeURI on an already-encoded pathname (that
// double-encodes %20 → %2520).
function normalizeMediaUrl(rawUrl) {
  if (!rawUrl) return rawUrl
  try {
    return new URL(rawUrl).toString()
  } catch {
    return String(rawUrl).replace(/ /g, '%20')
  }
}

function isInterstitialAd(url) {
  return /obqj|aliexpress|s\.click|rtmark|partitial|propeller/i.test(url || '')
}

// ─── HEAD-probe a CDN URL (kept for legacy callers) ───
async function probeUrl(url) {
  try {
    const res = await fetchWithTimeout(url, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    }, 4000)
    return res.ok || res.status === 206
  } catch { return false }
}

// ─── Build a CDN URL (kept for legacy callers) ───
function buildCdnUrl(cdnHost, showName, seasonNum, epNum, suffix) {
  const encoded = encodeURIComponent(showName)
  const s = String(seasonNum).padStart(2, '0')
  const e = String(epNum).padStart(2, '0')
  if (suffix) {
    return `http://${cdnHost}.o2tv.org/${encoded}/Season%20${s}/${encoded}%20-%20S${s}E${e}%20(TvShows4Mobile.Com)%20${encodeURIComponent(suffix)}.mp4`
  }
  return `http://${cdnHost}.o2tv.org/${encoded}/Season%20${s}/${encoded}%20-%20S${s}E${e}%20(TvShows4Mobile.Com).mp4`
}

/**
 * Solve a captcha image using Groq vision API.
 * Tries each model in VISION_MODELS until one accepts image input and returns
 * a plausible answer — resilient to Groq deprecating individual models.
 */
async function solveCaptchaWithGroq(imageBuffer) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured — cannot solve captcha')
  }

  const base64 = imageBuffer.toString('base64')
  const dataUrl = `data:image/png;base64,${base64}`

  let lastError = null
  for (const model of VISION_MODELS) {
    try {
      const res = await fetchWithTimeout(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Read the text in this captcha image. Reply with ONLY the exact text characters shown, no explanation, no quotes, no extra words. Just the text.',
              },
              {
                type: 'image_url',
                image_url: { url: dataUrl },
              },
            ],
          }],
          max_tokens: 20,
          temperature: 0.1,
        }),
      }, 15000)

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        lastError = new Error(err.error?.message || `Groq API returned HTTP ${res.status}`)
        // 404 / decommissioned → try the next model
        if (res.status === 404 || /decommission|not found|no longer supported/i.test(lastError.message)) {
          continue
        }
        continue
      }

      const data = await res.json()
      const text = data.choices?.[0]?.message?.content?.trim() || ''
      const cleaned = text.replace(/[^a-zA-Z0-9]/g, '').trim()
      if (cleaned.length >= 3) {
        return cleaned
      }
      lastError = new Error('Empty/short captcha answer from ' + model)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError || new Error('All Groq vision models failed')
}

/**
 * Perform ONE captcha solve + POST within a cookie jar, retrying with a FRESH
 * captcha image each round. The vision model misreads some images, so reusing
 * the same image is pointless — we must fetch a new one per attempt.
 *
 * Establishes the session once (download → areyouhuman), then loops:
 *   fetch fresh image → solve → POST → if "incorrect"/no-location, next image.
 * Returns the raw POST Location (ad interstitial, media URL, or '').
 */
async function solveAndPost(jar, fileId, maxAttempts = 6) {
  const BASE = 'https://tvshows4mobile.org'

  // download → captcha flow (captures ci_session / PHPSESSID) — ONCE
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
  await capRes.text() // advance session state

  // Retry solving with a FRESH captcha image each attempt.
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Fetch a fresh captcha image. A WRONG answer can briefly lock the endpoint
    // (it returns the HTML error page instead of an image) — wait + retry instead
    // of failing the whole resolve.
    let imgBuffer = null
    for (let imgTry = 0; imgTry < 3 && !imgBuffer; imgTry++) {
      const imgRes = await fetchWithTimeout(`${BASE}/simplecaptcha1/simple-php-captcha.php?_CAPTCHA&t=${Date.now()}`, {
        headers: { 'User-Agent': USER_AGENT, Cookie: jar.header(), Referer: captchaPageUrl },
      }, 8000)
      jar.capture(imgRes)
      const contentType = imgRes.headers.get('content-type') || ''
      if (contentType.includes('image')) {
        imgBuffer = Buffer.from(await imgRes.arrayBuffer())
      } else {
        // Lockout / stale session — back off and retry the image fetch
        await new Promise((r) => setTimeout(r, 1200))
      }
    }
    if (!imgBuffer) {
      console.error(`No captcha image after retries (attempt ${attempt + 1}/${maxAttempts})`)
      continue
    }

    let captchaAnswer = ''
    try {
      captchaAnswer = await solveCaptchaWithGroq(imgBuffer)
    } catch (err) {
      console.error(`Captcha solve error (attempt ${attempt + 1}/${maxAttempts}):`, err.message)
      continue // fresh image next round
    }
    // Reject answers of clearly wrong length WITHOUT POSTing them. Empirically
    // these captchas are exactly 5 chars; a wrong-length answer is almost always
    // a misread, and POSTing it triggers an endpoint lockout.
    if (!captchaAnswer || captchaAnswer.length < 4 || captchaAnswer.length > 6) {
      console.error(`Captcha answer "${captchaAnswer}" has odd length ${captchaAnswer.length} (attempt ${attempt + 1}/${maxAttempts}) — skipping, fresh image`)
      continue
    }

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
      // Wrong answer returns a 200 body with an error → retry fresh image
      const body = await postRes.text().catch(() => '')
      if (/does not match|incorrect|invalid captcha/i.test(body)) {
        console.error(`Captcha answer "${captchaAnswer}" was incorrect (attempt ${attempt + 1}/${maxAttempts}) — retrying with fresh image`)
        continue
      }
    }
    return location
  }
  return '' // exhausted fresh-image retries
}

/**
 * Resolve an o2tv download ID to the real CDN MP4 URL.
 *
 * tvshows4mobile serves an interstitial ad on the FIRST captcha solve per
 * session; the SECOND solve (same validated session) yields the real CDN URL
 * with the per-file suffix (otv-XXXXX). So when the first POST redirects to an
 * ad, we immediately solve again — the "go back and try again" behaviour.
 *
 * @param {number} fileId - The download file ID from the episode page
 * @returns {Promise<string|null>} - The CDN URL, or null if failed
 */
export async function resolveO2TvCaptcha(fileId) {
  const jar = new CookieJar()

  // Solve #1
  let location = await solveAndPost(jar, fileId).catch((err) => {
    console.error(`solveAndPost #1 failed for ${fileId}:`, err.message)
    return ''
  })

  // If the first solve hit the interstitial ad, solve AGAIN in the same session.
  // The validated session now skips the ad and returns the real media URL.
  if (isInterstitialAd(location) || !location) {
    location = await solveAndPost(jar, fileId).catch((err) => {
      console.error(`solveAndPost #2 failed for ${fileId}:`, err.message)
      return ''
    })
  }

  if (!location) return null

  // Already a direct media URL / CDN host
  if (/\.(mp4|mkv|m3u8|webm)(\?|#|$)/i.test(location) || /o2tv\.org/i.test(location)) {
    return normalizeMediaUrl(location)
  }

  // Still an ad after two solves — give up on this fileId
  if (isInterstitialAd(location)) return null

  // Otherwise follow the remaining redirect chain on tvshows4mobile itself
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
    } catch {
      break
    }
  }
  return null
}

/**
 * Classify an O2TV episode download option by quality.
 * Prefer basic progressive MP4 — HD is too large for proxy/Hobby, 3gp is too low.
 *
 * Rank (lower = try first):
 *   0 = basic Mp4 (\"Basic Quality, Small Size\")  ← preferred
 *   1 = other/unknown mp4-like
 *   2 = HD Mp4 (\"Highest Quality, Largest Size\") ← fallback only
 *   3 = 3gp / low (\"Lowest Quality\")             ← last resort
 */
function classifyO2TvDownload(label, context = '') {
  const text = `${label || ''} ${context || ''}`.toLowerCase()
  if (/\b3gp\b/.test(text) || /lowest quality|smallest size/.test(text)) {
    return { tier: '3gp', rank: 3, quality: '3gp' }
  }
  if (/\bhd\b/.test(text) || /highest quality|largest size/.test(text)) {
    return { tier: 'hd', rank: 2, quality: 'HD' }
  }
  if (
    /\bmp4\b/.test(text)
    || /basic quality|small size/.test(text)
    || /in mp4 format/.test(text)
  ) {
    if (!/\bhd\b/.test(text) && !/\b3gp\b/.test(text)) {
      return { tier: 'basic', rank: 0, quality: 'MP4' }
    }
  }
  return { tier: 'unknown', rank: 1, quality: 'MP4' }
}

/**
 * Parse episode HTML into ranked download options (id + quality label).
 */
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
    options.push({
      fileId: id,
      label: label || `Download ${id}`,
      ...classified,
    })
  }

  if (!options.length) {
    const idRe = /\/download\/(\d+)/g
    let im
    while ((im = idRe.exec(epHtml)) !== null) {
      const id = parseInt(im[1], 10)
      if (!id || seen.has(id)) continue
      seen.add(id)
      options.push({
        fileId: id,
        label: `Download ${id}`,
        tier: 'unknown',
        rank: 1,
        quality: 'MP4',
      })
    }
  }

  options.sort((a, b) => a.rank - b.rank || a.fileId - b.fileId)
  return options
}

/**
 * Resolve an o2tv episode by:
 * 1. Getting download options from the episode page (ranked by quality)
 * 2. Prefer basic Mp4 (not HD, not 3gp)
 * 3. Solving captcha for the best option, falling back down the list
 * 4. Following redirects to get the CDN URL
 *
 * @param {string} showSlug - e.g., \"House-of-the-Dragon-otviao8f\"
 * @param {number} seasonNum - Season number (1-based)
 * @param {number} epNum - Episode number (1-based)
 * @returns {Promise<Array<{title, url, source, isDirect, playableInRoom, quality}>>}
 */
export async function resolveO2TvEpisodeViaCaptcha(showSlug, seasonNum, epNum) {
  const BASE = 'https://tvshows4mobile.org'
  const seasonPath = `Season-${String(seasonNum).padStart(2, '0')}`
  const episodePath = `Episode-${String(epNum).padStart(2, '0')}`
  const episodeUrl = `${BASE}/${showSlug}/${seasonPath}/${episodePath}/`

  const epRes = await fetchWithTimeout(episodeUrl, {
    headers: { 'User-Agent': USER_AGENT },
  }, 8000)

  if (!epRes.ok) return []

  const epHtml = await epRes.text()

  const options = parseO2TvDownloadOptions(epHtml)
  if (!options.length) return []

  const showName = showSlug
    .replace(/^download-/i, '')
    .replace(/-otv[a-z0-9]+$/i, '')
    .replace(/-/g, ' ')
    .trim()

  const s = String(seasonNum).padStart(2, '0')
  const e = String(epNum).padStart(2, '0')
  const title = `${showName} - S${s}E${e}`

  console.log(
    `O2TV quality order for ${showSlug} S${s}E${e}:`,
    options.map((o) => `${o.fileId}:${o.tier}`).join(' → '),
  )

  for (const opt of options) {
    try {
      const cdnUrl = await resolveO2TvCaptcha(opt.fileId)
      if (cdnUrl) {
        // Cache the suffix for future use
        const suffixMatch = cdnUrl.match(/otv-([a-z0-9]+)/i)
        if (suffixMatch) {
          const suffix = `otv-${suffixMatch[1]}`
          const cacheKey = `${showName}|S${s}E${e}`
          suffixCache.set(cacheKey, { suffix, ts: Date.now() })
        }

        return [{
          title,
          url: cdnUrl,
          link: cdnUrl,
          source: 'o2tv',
          isDirect: true,
          playableInRoom: /\.(mp4|webm|m3u8)/i.test(cdnUrl),
          quality: opt.quality || 'MP4',
          qualityTier: opt.tier,
          resolvedFileId: opt.fileId,
        }]
      }
    } catch (err) {
      console.error(`Captcha resolution failed for file ${opt.fileId} (${opt.tier}):`, err.message)
    }
  }

  return []
}
