/**
 * Serverless Puppeteer Browser Manager
 *
 * Uses @sparticuz/chromium + puppeteer-core on Vercel (production),
 * full puppeteer for local development.
 *
 * IMPORTANT: @sparticuz/chromium and puppeteer-core are in devDependencies
 * to avoid bundling 66MB into every Vercel function. On Vercel, these packages
 * are NOT available in the function runtime. Browser-based resolution is
 * therefore DISABLED on Vercel unless the packages are manually added to
 * the function's node_modules via a layer or build step.
 *
 * All callers should handle the case where getBrowser() throws —
 * the search will simply skip browser-dependent providers.
 */

let _browser = null
let _launchPromise = null
let _browserAvailable = null // null = unknown, true/false = tested

const IS_PRODUCTION = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production'

/**
 * Check if browser-based resolution is available.
 * On Vercel, returns false unless @sparticuz/chromium is in the function bundle.
 * On local dev, returns true if puppeteer is installed.
 */
export function isBrowserAvailable() {
  return _browserAvailable !== false
}

/**
 * Get a Puppeteer browser instance (launches if needed, reuses if warm)
 * Throws if browser packages are not available.
 */
export async function getBrowser() {
  if (_browserAvailable === false) {
    throw new Error('Browser is not available — @sparticuz/chromium not installed in this environment')
  }

  if (_browser && _browser.connected) {
    return _browser
  }

  // Deduplicate concurrent launch attempts
  if (_launchPromise) return _launchPromise

  _launchPromise = (async () => {
    try {
      if (IS_PRODUCTION) {
        // Production: @sparticuz/chromium (serverless-friendly)
        // This will throw if the package isn't in the function bundle
        let chromium, puppeteer
        try {
          chromium = (await import('@sparticuz/chromium')).default
          puppeteer = (await import('puppeteer-core')).default
        } catch (importErr) {
          _browserAvailable = false
          throw new Error('Browser packages not available — MeetDownload/Waploaded resolution disabled on this deployment')
        }

        _browser = await puppeteer.launch({
          args: [
            ...chromium.args,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--hide-scrollbars',
            '--disable-web-security',
          ],
          defaultViewport: chromium.defaultViewport,
          executablePath: await chromium.executablePath(),
          headless: chromium.headless,
          ignoreHTTPSErrors: true,
        })
        _browserAvailable = true
      } else {
        // Local dev: full puppeteer with bundled Chromium
        let puppeteer
        try {
          puppeteer = (await import('puppeteer')).default
        } catch (importErr) {
          _browserAvailable = false
          throw new Error('Puppeteer not installed — run `npm install` to enable browser-based resolution')
        }

        _browser = await puppeteer.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
          ],
        })
        _browserAvailable = true
      }

      // Auto-cleanup when browser disconnects
      _browser.on('disconnected', () => { _browser = null })

      return _browser
    } catch (err) {
      _browser = null
      throw err
    } finally {
      _launchPromise = null
    }
  })()

  return _launchPromise
}

/**
 * Close the shared browser instance
 */
export async function closeBrowser() {
  if (_browser) {
    try { await _browser.close() } catch { /* ignore */ }
    _browser = null
  }
}

/**
 * Resolve a page using Puppeteer — navigates, waits for JS/countdowns,
 * and extracts download links or direct media URLs.
 *
 * Returns empty array if browser is not available (graceful degradation).
 */
export async function resolveWithBrowser(url, options = {}) {
  const {
    timeout = 15000,
    waitForSelector = null,
    countdownSeconds = 6,
    extractFn = null,
  } = options

  let browser
  let page

  try {
    browser = await getBrowser()
    page = await browser.newPage()

    // Block unnecessary resources to speed up loading
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      const resourceType = req.resourceType()
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort()
      } else {
        req.continue()
      }
    })

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    )

    // Navigate to the page
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout,
    })

    // Wait for specific selector if provided
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 5000 }).catch(() => {})
    }

    // Wait for JS countdowns (many download sites have 5-10 second countdowns)
    if (countdownSeconds > 0) {
      await new Promise((r) => setTimeout(r, countdownSeconds * 1000))
    }

    // Extract results
    if (extractFn) {
      return await extractFn(page, url)
    }

    // Default extraction: find all direct media links on the page
    return await extractMediaLinks(page, url)
  } catch (err) {
    console.error('Browser resolution error:', err.message)
    return []
  } finally {
    if (page) {
      try { await page.close() } catch { /* ignore */ }
    }
  }
}

/**
 * Default media link extractor — finds all .mp4/.mkv/.m3u8 links on the page
 */
async function extractMediaLinks(page, pageUrl) {
  return await page.evaluate((originUrl) => {
    const mediaExts = /\.(mp4|m3u8|webm|mkv|avi)(\?|#|$)/i
    const results = []
    const seen = new Set()

    // Find links in <a> tags
    document.querySelectorAll('a[href]').forEach((el) => {
      const href = el.href
      if (href && mediaExts.test(href) && !seen.has(href)) {
        seen.add(href)
        results.push({
          title: el.textContent.trim() || decodeURIComponent(href.split('/').pop().split('?')[0]) || 'Video',
          url: href,
          link: href,
          source: 'browser',
          isDirect: true,
          playableInRoom: /\.(mp4|webm|m3u8)/i.test(href),
          resolvedFrom: originUrl,
        })
      }
    })

    // Find <source> and <video> elements
    document.querySelectorAll('video[src], video source[src], source[src]').forEach((el) => {
      const src = el.src
      if (src && !seen.has(src)) {
        seen.add(src)
        results.push({
          title: decodeURIComponent(src.split('/').pop().split('?')[0]) || 'Video',
          url: src,
          link: src,
          source: 'browser',
          isDirect: true,
          playableInRoom: true,
          resolvedFrom: originUrl,
        })
      }
    })

    // Find URLs in page source (inline JS, data attributes, etc.)
    const pageText = document.documentElement.innerHTML
    const urlRegex = /https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8|webm|mkv)(?:[?#][^\s"'<>]*)?/gi
    const matches = pageText.match(urlRegex) || []
    matches.forEach((raw) => {
      const clean = raw.replace(/&amp;/g, '&')
      if (!seen.has(clean)) {
        seen.add(clean)
        results.push({
          title: decodeURIComponent(clean.split('/').pop().split('?')[0]) || 'Video',
          url: clean,
          link: clean,
          source: 'browser',
          isDirect: true,
          playableInRoom: /\.(mp4|webm|m3u8)/i.test(clean),
          resolvedFrom: originUrl,
        })
      }
    })

    return results
  }, pageUrl)
}

/**
 * Extract page HTML after JS execution (for sites that render content dynamically)
 * Returns null if browser is not available.
 */
export async function getRenderedHtml(url, options = {}) {
  const { timeout = 10000, waitForSelector = null } = options

  let browser
  let page

  try {
    browser = await getBrowser()
    page = await browser.newPage()

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    )

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout,
    })

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 5000 }).catch(() => {})
    }

    return await page.content()
  } catch (err) {
    console.error('Browser HTML extraction error:', err.message)
    return null
  } finally {
    if (page) {
      try { await page.close() } catch { /* ignore */ }
    }
  }
}

/**
 * MeetDownload resolver — handles JS countdown and token extraction
 * Returns empty array if browser is not available.
 */
export async function resolveMeetDownload(url) {
  if (!isBrowserAvailable()) return []
  return await resolveWithBrowser(url, {
    countdownSeconds: 8,
    waitForSelector: 'a[href*=".mp4"], a[href*=".mkv"], a[href*="download"], .download-btn, #download',
    extractFn: async (page, pageUrl) => {
      // Wait for download button to appear
      await page.waitForFunction(() => {
        const links = document.querySelectorAll('a[href]')
        for (const link of links) {
          const href = link.href || ''
          if (href.includes('.mp4') || href.includes('.mkv') || href.includes('download')) {
            return true
          }
        }
        const btns = document.querySelectorAll('button, .btn, [class*="download"]')
        return btns.length > 0
      }, { timeout: 10000 }).catch(() => {})

      // Click any download buttons that might trigger link generation
      try {
        const downloadBtn = await page.$('a[href*="download"], button[class*="download"], .download-btn, #download')
        if (downloadBtn) {
          await downloadBtn.click()
          await new Promise((r) => setTimeout(r, 3000))
        }
      } catch { /* ignore */ }

      // Extract all media links from the rendered page
      return await extractMediaLinks(page, pageUrl)
    },
  })
}

/**
 * Waploaded resolver — handles JS-rendered search results
 * Returns empty array if browser is not available.
 */
export async function resolveWaploaded(url) {
  if (!isBrowserAvailable()) return []
  return await resolveWithBrowser(url, {
    timeout: 10000,
    countdownSeconds: 2,
    waitForSelector: 'a[href*="/movie/"], a[href*="/series/"], a[href*="/video/"], .result-item',
    extractFn: async (page, pageUrl) => {
      return await page.evaluate((originUrl) => {
        const results = []
        const seen = new Set()

        // Find media links
        document.querySelectorAll('a[href]').forEach((el) => {
          const href = el.href
          const text = el.textContent.trim()
          if (!href || seen.has(href)) return

          // Skip navigation/utility links
          if (href.includes('/search/') || href.includes('/page/') || href.includes('/feed/')) return

          const isMedia = /\/movie\/|\/series\/|\/video\/|\.mp4|\.mkv|download/i.test(href)
          if (isMedia && text) {
            seen.add(href)
            results.push({
              title: text.slice(0, 200),
              url: href,
              link: href,
              source: 'waploaded',
              isDirect: /\.(mp4|mkv|m3u8)/i.test(href),
              playableInRoom: /\.(mp4|webm|m3u8)/i.test(href),
              resolvedFrom: originUrl,
            })
          }
        })

        return results
      }, pageUrl)
    },
  })
}

/**
 * Generic browser-based resolver for any site that needs JS execution
 * Returns empty array if browser is not available.
 */
export async function resolveGenericBrowser(url, { countdown = 5, waitFor = null } = {}) {
  if (!isBrowserAvailable()) return []
  return await resolveWithBrowser(url, {
    countdownSeconds: countdown,
    waitForSelector: waitFor,
  })
}
