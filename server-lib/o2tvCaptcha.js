/**
 * O2TV Captcha Solver — Simple, clean version
 *
 * Solves the tvshows4mobile.org "are you human" CAPTCHA using Groq vision.
 *
 * Flow:
 *   1. GET areyouhuman.php → get captcha image URL + session cookie
 *   2. Download captcha image
 *   3. Send to Groq vision to read text
 *   4. POST form with captcha text → get CDN URL
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const BASE = 'https://tvshows4mobile.org'
const PROXY_URL = process.env.O2TV_PROXY_URL || 'https://zero2tv-proxy.onrender.com'
const GROQ_KEY = process.env.GROQ_API_KEY || ''
const TIMEOUT = 8000

function normalizeGroqCaptchaText(value) {
  return String(value || '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 16)
}

/**
 * OCR-only captcha solver for native Android.
 *
 * The Android client downloads the captcha image using its own O2TV session/IP,
 * sends only the image bytes here, and receives only the solved text. This keeps
 * GROQ_API_KEY on the server and out of the APK.
 */
export async function solveCaptchaImage(imageBase64) {
  if (!GROQ_KEY) {
    throw Object.assign(new Error('GROQ_API_KEY not configured on server'), { status: 503 })
  }

  const cleanBase64 = String(imageBase64 || '')
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .trim()

  if (!cleanBase64 || cleanBase64.length > 256_000 || !/^[a-zA-Z0-9+/=\r\n]+$/.test(cleanBase64)) {
    throw Object.assign(new Error('Invalid captcha image'), { status: 400 })
  }

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Read the text shown in this CAPTCHA image. Reply with ONLY the text characters, nothing else. No explanation, no quotes, no extra text.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${cleanBase64}` },
            },
          ],
        },
      ],
      max_tokens: 20,
      temperature: 0,
    }),
  })

  const groqData = await groqRes.json().catch(() => ({}))
  if (!groqRes.ok) {
    throw Object.assign(new Error(groqData?.error?.message || `Groq API failed: HTTP ${groqRes.status}`), { status: 502 })
  }

  const captchaText = normalizeGroqCaptchaText(groqData?.choices?.[0]?.message?.content)
  if (!captchaText || captchaText.length < 2) {
    throw Object.assign(new Error('Groq returned invalid captcha text'), { status: 502 })
  }

  return captchaText
}

/**
 * Fetch via proxy (for tvshows4mobile.org) or direct
 */
async function fetchWithProxy(url, options = {}) {
  const useProxy = url.includes('tvshows4mobile.org')
  const fetchUrl = useProxy
    ? `${PROXY_URL}/proxy?url=${encodeURIComponent(url)}`
    : url

  const res = await fetch(fetchUrl, {
    ...options,
    headers: useProxy
      ? { 'Accept': 'application/json' }
      : options.headers || {},
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }

  // If using proxy, parse JSON response
  if (useProxy) {
    const result = await res.json()
    if (result.status !== 200) {
      throw new Error(`Proxy returned HTTP ${result.status}`)
    }
    return {
      ok: true,
      url: result.url,
      headers: new Map([['content-type', result.contentType]]),
      text: async () => result.isBinary
        ? Buffer.from(result.data, 'base64').toString('utf-8')
        : result.data,
      arrayBuffer: async () => result.isBinary
        ? Buffer.from(result.data, 'base64').buffer
        : new TextEncoder().encode(result.data).buffer,
    }
  }

  return res
}

/**
 * Solve the captcha for a given file ID.
 * Retries 2-3 times due to redirect ads.
 * @param {number|string} fileId - The download file ID (e.g. 158224)
 * @param {number} attempts - Remaining attempts (default 3)
 * @returns {Promise<string|null>} The CDN URL, or null if failed
 */
export async function solveCaptcha(fileId, attempts = 3) {
  if (!GROQ_KEY) {
    console.error('O2TV captcha: GROQ_API_KEY not configured')
    return null
  }

  if (attempts <= 0) {
    console.error(`O2TV captcha: exhausted all attempts for fid=${fileId}`)
    return null
  }

  try {
    console.log(`[Captcha] Attempt ${4-attempts}/3 for fid=${fileId}`)

    // Step 1: Get the captcha page
    const pageRes = await fetchWithProxy(`${BASE}/areyouhuman.php?fid=${fileId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
    })
    const pageHtml = await pageRes.text()

    // Extract session cookie
    const cookieHeader = pageRes.headers.get('set-cookie') || ''
    const sessionCookie = cookieHeader.split(';')[0] || ''

    // Extract captcha image URL
    const captchaMatch = pageHtml.match(/simple-php-captcha\.php\?_CAPTCHA[^"'\s]*/i)
    if (!captchaMatch) {
      console.error('O2TV captcha: no captcha image found')
      return null
    }
    const captchaUrl = `${BASE}/${captchaMatch[0].replace(/&amp;/g, '&')}`

    // Step 2: Download the captcha image
    const imgRes = await fetchWithProxy(captchaUrl, {
      headers: { 'User-Agent': UA, Cookie: sessionCookie },
    })
    const imgBuffer = await imgRes.arrayBuffer()
    const imgBase64 = Buffer.from(imgBuffer).toString('base64')

    // Step 3: Send to Groq vision to read the text
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Read the text shown in this CAPTCHA image. Reply with ONLY the text characters, nothing else. No explanation, no quotes, no extra text.',
              },
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${imgBase64}` },
              },
            ],
          },
        ],
        max_tokens: 20,
        temperature: 0,
      }),
    })

    const groqData = await groqRes.json()
    const captchaText = normalizeGroqCaptchaText(groqData?.choices?.[0]?.message?.content)

    if (!captchaText || captchaText.length < 2) {
      console.error('O2TV captcha: Groq returned empty/invalid text:', captchaText)
      return null
    }

    console.log(`[Captcha] Groq read "${captchaText}" for fid=${fileId}`)

    // Step 4: Submit the form
    const formBody = new URLSearchParams({
      captchainput: captchaText,
      submit: 'Continue Download',
    }).toString()

    const submitRes = await fetchWithProxy(`${BASE}/areyouhuman.php?fid=${fileId}`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: sessionCookie,
        Referer: `${BASE}/areyouhuman.php?fid=${fileId}`,
      },
      body: formBody,
      redirect: 'manual', // Don't follow redirects automatically
    })

    // Check for redirects (ads)
    if (submitRes.status >= 300 && submitRes.status < 400) {
      const redirectUrl = submitRes.headers.get('location') || ''
      console.log(`[Captcha] Got redirect (ad?): ${redirectUrl}`)

      // If it's an ad redirect, go back and try again
      if (redirectUrl && !redirectUrl.includes('o2tv.org') && !redirectUrl.includes('.mp4')) {
        console.log(`[Captcha] Ad redirect detected, retrying... (${attempts-1} left)`)
        await new Promise(r => setTimeout(r, 1500)) // Wait before retry
        return solveCaptcha(fileId, attempts - 1)
      }

      // If it's a CDN redirect, follow it
      if (redirectUrl && (redirectUrl.includes('o2tv.org') || redirectUrl.includes('.mp4'))) {
        console.log(`[Captcha] CDN redirect: ${redirectUrl.slice(0, 80)}...`)
        return redirectUrl
      }
    }

    // Handle direct response (200)
    if (submitRes.status === 200) {
      const body = await submitRes.text()

      // Check if we got a video URL in the body
      const linkMatch = body.match(/https?:\/\/[^"'\s<>\)]+\.mp4[^"'\s<>\)]*/i)
        || body.match(/https?:\/\/[^"'\s<>\)]*o2tv\.org[^"'\s<>\)]*/i)

      if (linkMatch) {
        const cdnUrl = linkMatch[0].replace(/&amp;/g, '&')
        console.log(`[Captcha] Resolved fid=${fileId} → ${cdnUrl.slice(0, 80)}...`)
        return cdnUrl
      }

      // Check if captcha was wrong
      if (body.includes('Captcha Does Not Match') || body.includes('captcha')) {
        console.log(`[Captcha] Wrong text "${captchaText}", retrying... (${attempts-1} left)`)
        await new Promise(r => setTimeout(r, 1000))
        return solveCaptcha(fileId, attempts - 1)
      }

      // Check for ad redirects in the body
      const adRedirect = body.match(/window\.location\.href\s*=\s*["']([^"']+)["']/i)
        || body.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["']\d+;\s*url=([^"']+)["']/i)

      if (adRedirect) {
        const adUrl = adRedirect[1]
        console.log(`[Captcha] Ad redirect in body: ${adUrl}`)
        if (!adUrl.includes('o2tv.org') && !adUrl.includes('.mp4')) {
          console.log(`[Captcha] Ad detected, retrying... (${attempts-1} left)`)
          await new Promise(r => setTimeout(r, 1500))
          return solveCaptcha(fileId, attempts - 1)
        }
      }
    }

    console.error(`[Captcha] No CDN URL for fid=${fileId}, status=${submitRes.status}`)
    return null
  } catch (err) {
    console.error('[Captcha] Error:', err.message)
    return null
  }
}

/**
 * Resolve an O2TV episode to a CDN URL via captcha solving.
 * @param {string} episodeUrl - The episode page URL on tvshows4mobile.org
 * @returns {Promise<string|null>} CDN URL or null
 */
export async function resolveViaCaptcha(episodeUrl) {
  try {
    // Get the episode page to find download links
    const res = await fetchWithProxy(episodeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
    })
    const html = await res.text()

    // Find download links (e.g. /download/158224)
    const downloadLinks = []
    const linkRegex = /href="[^"]*\/download\/(\d+)"[^>]*>([^<]*)/gi
    let match
    while ((match = linkRegex.exec(html)) !== null) {
      const fileId = match[1]
      const text = match[2].toLowerCase().trim()
      downloadLinks.push({ fileId, text })
    }

    if (!downloadLinks.length) {
      // Also try generic download link pattern
      const ids = html.match(/\/download\/(\d+)/g) || []
      for (const id of ids) {
        const fileId = id.replace('/download/', '')
        downloadLinks.push({ fileId, text: 'download' })
      }
    }

    if (!downloadLinks.length) {
      console.error('O2TV captcha: no download links found on', episodeUrl)
      return null
    }

    // Prefer MP4/HD links
    downloadLinks.sort((a, b) => {
      const scoreA = /mp4|hd|720|1080|480/.test(a.text) ? 10 : 0
      const scoreB = /mp4|hd|720|1080|480/.test(b.text) ? 10 : 0
      return scoreB - scoreA
    })

    // Try each download link
    for (const { fileId } of downloadLinks.slice(0, 3)) {
      const cdnUrl = await solveCaptcha(fileId)
      if (cdnUrl) return cdnUrl
    }

    return null
  } catch (err) {
    console.error('O2TV captcha resolve error:', err.message)
    return null
  }
}
