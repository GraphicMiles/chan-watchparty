export const SITE_CONFIGS = {
  nkiri: {
    label: 'Nkiri / Thenkiri',
    baseUrl: 'https://thenkiri.com',
    items: '.list-movies .movie-item, .movies-list .item, .post-item, article, a[href*="downloadwella.com"]',
    title: '.movie-title, .entry-title, h2 a, h3 a, .title, a[href*="downloadwella.com"]',
    image: 'img[src], .poster img, .thumb img, img[data-src]',
    link: 'a[href*="downloadwella.com"], a[href], .download-link a, a[href*="/download/"]',
    meta: '.meta, .date, .year, .quality',
    buildSearchUrl: (q) => `https://thenkiri.com/?s=${encodeURIComponent(q)}`,
    buildSearchUrls: (q) => [
      `https://thenkiri.com/?s=${encodeURIComponent(q)}`,
      `https://thenkiri.com/search/${encodeURIComponent(q)}`,
      `https://thenkiri.com/?q=${encodeURIComponent(q)}`,
    ],
  },
  netnaija: {
    label: 'NetNaija',
    baseUrl: 'https://thenetnaija.ng',
    items: '.file-item, article.post, .video-item, .content-box',
    title: '.file-title, .entry-title h1, h1, h2, .title',
    image: 'img.wp-post-image, .featured-image img, img[data-src]',
    link: 'a[href*="/download/"], a[href*=".mp4"], a[href*=".mkv"], a.dlm-button',
    meta: '.file-meta, .post-meta, .category',
    buildSearchUrl: (q) => `https://thenetnaija.ng/search?q=${encodeURIComponent(q)}`,
    buildSearchUrls: (q) => [
      `https://thenetnaija.ng/search?q=${encodeURIComponent(q)}`,
      `https://thenetnaija.ng/videos/search?q=${encodeURIComponent(q)}`,
      `https://thenetnaija.ng/?s=${encodeURIComponent(q)}`,
    ],
  },
  fzmovies: {
    label: 'FZMovies',
    baseUrl: 'https://fzmovies.net',
    items: '.movielist .movie, .movie-item, .content-box, article, .post',
    title: '.moviename, .movie-title, h2 a, b a, .title',
    image: 'img[src], .movieimg img, .poster img, img[data-src]',
    link: 'a[href], .downloadlink a, a[href*="/download/"]',
    meta: '.movieinfo, .meta, small, .year',
    buildSearchUrl: (q) => `https://fzmovies.ng/?s=${encodeURIComponent(q)}`,
    buildSearchUrls: (q) => [
      `https://fzmovies.ng/?s=${encodeURIComponent(q)}`,
      `https://fzmovies.net/csearch.php?searchname=${encodeURIComponent(q)}`,
      `https://fzmovies.net/search.php?q=${encodeURIComponent(q)}`,
      `https://fzmovies.net/?s=${encodeURIComponent(q)}`,
    ],
  },
  o2tv: {
    label: 'O2TV Series',
    baseUrl: 'http://d6.o2tv.org',
    items: 'a[href$=".mp4"], a[href$=".mkv"], a[href$=".avi"]',
    title: 'title, h1',
    image: 'img[src]',
    link: 'a[href$=".mp4"], a[href$=".mkv"], a[href$=".avi"], a[href$=".mov"]',
    meta: '.info',
    isDirectListing: true,
    buildSearchUrl: (q) => null,
    buildSearchUrls: (q) => [
      `http://d6.o2tv.org/search.php?q=${encodeURIComponent(q)}`,
      `http://d6.o2tv.org/?s=${encodeURIComponent(q)}`,
    ],
    constructDirectUrl: (show, season = 1, episode = 1) => {
      const cleanShow = String(show || '')
        .replace(/^Download-/i, '')
        .replace(/-otv[a-z0-9]+$/i, '')
        .replace(/-/g, ' ')
        .trim()
      const encodedShow = encodeURIComponent(cleanShow)
      const seasonNum = String(season).padStart(2, '0')
      const epNum = String(episode).padStart(2, '0')
      // NOTE: The suffix (otv-XXXXX) is per-file random and must be resolved
      // via the o2tvResolver engine. This URL is a fallback that may 404.
      return `http://d6.o2tv.org/${encodedShow}/Season%20${seasonNum}/${encodedShow}%20-%20S${seasonNum}E${epNum}%20(TvShows4Mobile.Com)%20otv-1awrk.mp4`
    },
  },
  '9jarocks': {
    label: '9jaRocks',
    baseUrl: 'https://9jarocks.net',
    items: '.post-item, article, .movie-item, .blog-entry, .file-item, .item',
    title: '.post-title a, h2 a, h3 a, .entry-title a, .title',
    image: 'img[src], .post-thumb img, .featured-image img, img.wp-post-image, img[data-src]',
    link: '.post-title a, a[href*="/download/"], a[href*=".mp4"], a[href*=".mkv"], a.more-link, h2 a',
    meta: '.post-meta, .entry-meta, .category, .date',
    buildSearchUrl: (q) => `https://9jarocks.net/findx?search=${encodeURIComponent(q)}`,
    buildSearchUrls: (q) => [
      `https://9jarocks.net/findx?search=${encodeURIComponent(q)}`,
      `https://9jarocks.net/search?q=${encodeURIComponent(q)}`,
      `https://9jarocks.net/?s=${encodeURIComponent(q)}`,
    ],
  },
  naijaprey: {
    label: 'NaijaPrey',
    baseUrl: 'https://www.naijaprey.tv',
    items: 'article.post, article, .search-results article, .content-area article, .post-item',
    title: '.entry-title a, h2 a, h3 a, a[href*="naijaprey.tv/"]',
    image: 'img[src], img[data-src], .post-thumbnail img, article img',
    link: 'a[href*="naijaprey.tv/"], a[href*="np-downloader.com"], .entry-title a, a[href]',
    meta: '.rating, [class*="rating"], .entry-meta',
    buildSearchUrl: (q) => `https://www.naijaprey.tv/?s=${encodeURIComponent(q)}`,
    buildSearchUrls: (q) => [
      `https://www.naijaprey.tv/?s=${encodeURIComponent(q)}`,
    ],
  },
  fztvseries: {
    label: 'FZTVSeries',
    baseUrl: 'https://fztvseries.ng',
    items: 'article.post, article, .search-entry',
    title: '.search-entry-title a, .entry-title a, h2 a, a[rel="bookmark"]',
    image: 'img.wp-post-image, .search-entry img, img[src], img[data-src]',
    link: 'a[href*="wideshares.org"], a[href*="downloadwella.com"], .search-entry-readmore a, a[rel="bookmark"]',
    meta: '.search-entry-summary, .entry-meta',
    buildSearchUrl: (q) => `https://fztvseries.ng/?s=${encodeURIComponent(q)}`,
    buildSearchUrls: (q) => [
      `https://fztvseries.ng/?s=${encodeURIComponent(q)}`,
    ],
  },
  archiveorg: {
    label: 'Internet Archive',
    baseUrl: 'https://archive.org',
    items: 'div.result, .item-ia',
    title: '.ttl, .item-title, h2',
    image: 'img[src]',
    link: 'a[href*="archive.org/download/"], a[href*="archive.org/details/"]',
    meta: '.result-metadata',
    // Internet Archive has its own JSON API — handled in api/media.js
    isJsonApi: true,
    buildSearchUrl: (q) => `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}+mediatype:movies&output=json&rows=20&fl[]=identifier,title,mediatype,downloads,year,description`,
  },
  spankbang: {
    label: 'SpankBang',
    baseUrl: 'https://spankbang.party',
    items: '.video-item, .thumb',
    title: '.title, h1, h2',
    image: 'img[src], img[data-src]',
    link: 'a[href]',
    meta: '.duration, .views',
    isNSFW: true,
  },
  custom: {
    label: 'Custom URL',
    items: 'article, .post, .item, .card, .movie, .video, a[href*="downloadwella.com"]',
    title: 'h1, h2, h3, .title, [class*="title"], a[href*="downloadwella.com"]',
    image: 'img[src], [class*="poster"] img, img[data-src]',
    link: 'a[href*="downloadwella.com"], a[href], a[href*=".mp4"], a[href*=".mkv"]',
    meta: '.meta, .date, .info',
  },
}

export function getSiteConfig(site) {
  return SITE_CONFIGS[site] || SITE_CONFIGS.custom
}

export function resolveUrl(src, baseUrl) {
  if (!src) return null
  try {
    if (src.startsWith('http://') || src.startsWith('https://')) return src
    if (src.startsWith('//')) return `https:${src}`
    return new URL(src, baseUrl).href
  } catch {
    return src
  }
}

export function isSuitableThumbnail(url) {
  if (!url || typeof url !== 'string') return false
  const clean = url.trim().toLowerCase()
  if (!clean || clean.startsWith('data:') || clean === 'null' || clean === 'undefined') return false
  if (clean.includes('downloadwella.com') || clean.includes('downloadwella')) return false
  if (clean.includes('np-downloader.com') || clean.includes('wildshare.net')) return false
  if (clean.includes('naijaprey.tv/wp-content') && /telegram|logo|banner|favicon|badge/i.test(clean)) return false
  if (/\b(arrow|download|logo|icon|placeholder|default|avatar|gravatar|spinner|loading|no-image|missing|blank|button|1x1|pixel)(\.|-|_|\b)/i.test(clean)) return false
  if (clean.endsWith('.svg') || clean.endsWith('.ico')) return false
  return true
}

export function cleanTitleForMatching(str) {
  if (!str) return ''
  return String(str)
    .replace(/\b(nkiri|thenkiri|netnaija|thenetnaija|fzmovies|9jarocks|animedrive|o2tvseries|o2tv|downloadwella|tvshows4mobile|naijaprey|fztvseries|wideshares|archive\.org|archiveorg|webrip|hdrip|bluray|brrip|720p|1080p|2160p|4k|x264|h264|x265|hevc|mp4|mkv|avi|m3u8|webm)\b/gi, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\.(mp4|mkv|m3u8|avi|mov)$/i, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .toLowerCase()
    .trim()
}

export function cleanTitleForOMDb(str) {
  if (!str) return ''
  return String(str)
    .replace(/\b(nkiri|thenkiri|netnaija|thenetnaija|fzmovies|9jarocks|animedrive|o2tvseries|o2tv|downloadwella|tvshows4mobile|naijaprey|naijaprey\.com|naijaprey\.tv|fztvseries|fztvseries\.ng|wideshares|archive\.org|archiveorg|webrip|hdrip|bluray|brrip|720p|1080p|2160p|4k|x264|h264|x265|hevc|mp4|mkv|avi|m3u8|webm)\b/gi, ' ')
    .replace(/\b(s\d+\s*e\d+|e\d+|s\d+|season\s*\d+|episode\s*\d+)\b/gi, ' ')
    .replace(/\b(part\s*\d+)\b/gi, ' ')
    .replace(/\b(complete|full|movie|film|download|free|watch|online|hd|uhd)\b/gi, ' ')
    .replace(/\b(com|net|org|tv)\b/g, ' ')
    .replace(/\b(19\d\d|20\d\d)\b/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\.(mp4|mkv|m3u8|avi|mov)$/i, ' ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
}

export function isTitleMatch(title, query) {
  if (!title || !query) return false
  const qRaw = String(query).trim()
  const tRaw = String(title).trim()
  if (!qRaw || !tRaw) return false

  const qClean = cleanTitleForMatching(qRaw)
  const tClean = cleanTitleForMatching(tRaw)
  if (!qClean || !tClean) return false

  // 1. Exact clean match
  if (tClean === qClean) return true

  // 2. Word-boundary exact phrase match inside title (e.g. query "silo" inside "silo season 1 episode 1", or "house of the dragon" in "house of the dragon s02e01")
  const phraseRegex = new RegExp('\\b' + qClean.replace(/\s+/g, '\\s+') + '\\b', 'i')
  if (phraseRegex.test(tClean)) return true

  // 3. No-spaces comparison for compound terms (e.g. query "super girl" vs title "supergirl s01e01" or "spider man" vs "spiderman")
  const qNoSpaces = qClean.replace(/\s+/g, '')
  const tNoSpaces = tClean.replace(/\s+/g, '')
  if (qNoSpaces.length >= 4) {
    if (tNoSpaces === qNoSpaces || new RegExp('\\b' + qNoSpaces + '\\b', 'i').test(tClean) || new RegExp('\\b' + qNoSpaces + '\\b', 'i').test(tNoSpaces)) {
      return true
    }
  }

  // 4. Strict multi-word token check (e.g. "house of the dragon")
  const qTokens = qClean.split(/\s+/).filter(t => t.length >= 2 && !['of', 'the', 'in', 'at', 'to', 'and', 'for', 'with', 'by', 'from', 'on', 'or', 'a', 'an'].includes(t))
  if (qTokens.length >= 2) {
    const allQueryTokensInTitle = qTokens.every(token => new RegExp('\\b' + token + '\\b', 'i').test(tClean))
    if (allQueryTokensInTitle) {
      return true
    }
  }

  return false
}
