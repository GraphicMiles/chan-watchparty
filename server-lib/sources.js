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
      const seasonNum = String(season).padStart(2, '0')
      const epNum = String(episode).padStart(2, '0')
      return `http://d6.o2tv.org/${cleanShow}/Season%20${seasonNum}/${cleanShow}%20-%20S${seasonNum}E${epNum}%20(TvShows4Mobile.Com)%20otv-1awrk.mp4`
    },
  },
  spankbang: {
    label: 'SpankBang',
    baseUrl: 'https://spankbang.com',
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
