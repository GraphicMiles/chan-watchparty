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
const GROQ_KEY = process.env.GROQ_API_KEY || ''
const TIMEOUT = 8000

/**
 * Solve the captcha for a given file ID.
 * @param {number|string} fileId - The download file ID (e.g. 158224)
 * @returns {Promise<string|null>} The CDN URL, or null if failed
 */
export async function solveCaptcha(fileId) {
  if (!GROQ_KEY) {
    console.error('O2TV captcha: GROQ_API_KEY not configured')
    return null
  }

  try {
    // Step 1: Get the captcha page
    const pageRes = await fetch(`${BASE}/areyouhuman.php?fid=${fileId}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
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
    const imgRes = await fetch(captchaUrl, {
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
    const captchaText = groqData?.choices?.[0]?.message?.content?.trim()

    if (!captchaText || captchaText.length < 2) {
      console.error('O2TV captcha: Groq returned empty/invalid text:', captchaText)
      return null
    }

    console.log(`O2TV captcha: Groq read "${captchaText}" for fid=${fileId}`)

    // Step 4: Submit the form
    const formBody = new URLSearchParams({
      captchainput: captchaText,
      submit: 'Continue Download',
    }).toString()

    const submitRes = await fetch(`${BASE}/areyouhuman.php?fid=${fileId}`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: sessionCookie,
        Referer: `${BASE}/areyouhuman.php?fid=${fileId}`,
      },
      body: formBody,
      redirect: 'follow',
    })

    // The response should redirect to the CDN URL
    const finalUrl = submitRes.url || ''

    // Check if we got a video URL
    if (finalUrl && (finalUrl.includes('.mp4') || finalUrl.includes('o2tv.org') || finalUrl.includes('video'))) {
      console.log(`O2TV captcha: resolved fid=${fileId} → ${finalUrl.slice(0, 80)}...`)
      return finalUrl
    }

    // If not redirected, check response body for a link
    const body = await submitRes.text()
    const linkMatch = body.match(/https?:\/\/[^"'\s<>\)]+\.mp4[^"'\s<>\)]*/i)
      || body.match(/https?:\/\/[^"'\s<>\)]*o2tv\.org[^"'\s<>\)]*/i)

    if (linkMatch) {
      const cdnUrl = linkMatch[0].replace(/&amp;/g, '&')
      console.log(`O2TV captcha: resolved fid=${fileId} (from body) → ${cdnUrl.slice(0, 80)}...`)
      return cdnUrl
    }

    // Check if captcha was wrong
    if (body.includes('Captcha Does Not Match') || body.includes('captcha')) {
      console.error(`O2TV captcha: wrong text "${captchaText}" for fid=${fileId}`)
      // Retry once with a fresh captcha
      return null
    }

    console.error('O2TV captcha: no CDN URL found in response for fid=' + fileId)
    return null
  } catch (err) {
    console.error('O2TV captcha error:', err.message)
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
    const res = await fetch(episodeUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
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
