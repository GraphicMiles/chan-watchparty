/**
 * titleFormat — clean scraped filenames into user-facing titles.
 *
 * Raw resolver output looks like:
 *   "Silo.S03E01.(THENKIRI.COM).mkv.html"
 *   "House.of.the.Dragon.S03E02.(THENKIRI.COM).mkv"
 *   "squid.game.s03.complete.korean.drama"
 *
 * Users should only ever see e.g. "Silo — S03E01" or "House of the Dragon".
 * Raw filenames, hosting domains and file extensions stay in the data layer
 * (the resolver needs them to fetch the stream) — never in UI text.
 *
 * Titles that are already clean (YouTube results, IPTV channel names, human
 * titles) pass through untouched — only slug/filename-like strings are parsed.
 */

const HOST_TOKENS = /\(?\b(THENKIRI|NKIRI|DOWNLOADWELLA|FSMC|O2TV|TVSHOWS4MOBILE)(?:\.COM)?\)?/gi
const FILE_EXT_RE = /\.(mkv|mp4|m3u8|webm|avi|mov|flv|ts)(?:\.html?)?$/i
const HTML_EXT_RE = /\.html?$/i
const SXXEYY_RE = /\bS(\d{1,2})\s*E(\d{1,2})\b/i
const SXX_RE = /\bS(\d{1,2})\b/i
const SLUG_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/i // dot/dash/underscore-joined slug
const TRAILING_COMPLETE_RE = /\s+(complete\s+)?(tv\s+)?series$/i

const SMALL_WORDS = new Set(['of', 'the', 'and', 'a', 'an', 'to', 'for', 'in', 'on', 'at', 'with', 'vs'])

function titleCase(str) {
  return str
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w, i) => {
      if (i > 0 && SMALL_WORDS.has(w)) return w
      return w[0].toUpperCase() + w.slice(1)
    })
    .join(' ')
}

/** True when the string looks like a scraped filename/slug (needs parsing). */
function looksLikeFilename(t) {
  return (
    FILE_EXT_RE.test(t)
    || HOST_TOKENS.test(t)
    || (SXXEYY_RE.test(t) && /[._-]/.test(t))
    // dot/dash/underscore-joined slug with no spaces
    || (SLUG_RE.test(t.replace(/\s+/g, '.')) && !t.includes(' '))
    // lowercase scraped title carrying a season marker, e.g. "silo s03 complete tv series"
    || (/^[a-z0-9\s]+$/.test(t) && SXX_RE.test(t))
  )
}

/**
 * Clean a scraped filename / raw title into display form.
 *  - strips file extensions (.mkv.html, .mp4, …)
 *  - strips hosting tokens ((THENKIRI.COM), downloadwella, …)
 *  - normalizes separators (. _ -) to spaces
 *  - detects SxxEyy → "Show — S03E05"
 *  - otherwise Title Case with small words; trailing "complete tv series" trimmed
 *  - already-clean titles (YouTube, IPTV, human titles) pass through untouched
 */
export function cleanMediaTitle(raw) {
  if (!raw) return ''
  let t = String(raw).trim()

  // If a URL sneaks in, keep only the path (decoded)
  try {
    const u = new URL(t, 'https://chan.invalid')
    if (/^https?:$/.test(u.protocol) && u.hostname !== 'chan.invalid') {
      t = decodeURIComponent(u.pathname)
    }
  } catch { /* not a URL */ }

  t = t.replace(FILE_EXT_RE, '').replace(HTML_EXT_RE, '')
  if (!looksLikeFilename(t)) return String(raw).trim()
  t = t.replace(HOST_TOKENS, ' ')
  t = t.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return ''

  const ep = t.match(SXXEYY_RE)
  if (ep) {
    const show = t.replace(SXXEYY_RE, ' ').replace(/\s+/g, ' ').trim()
    const showName = show ? titleCase(show) : ''
    return showName ? `${showName} — S${ep[1]}E${ep[2]}` : `S${ep[1]}E${ep[2]}`
  }

  const season = t.match(SXX_RE)
  if (season) {
    const show = t.replace(SXX_RE, ' ').replace(TRAILING_COMPLETE_RE, '').replace(/\s+/g, ' ').trim()
    const showName = show ? titleCase(show) : ''
    return showName ? `${showName} — Season ${season[1]}` : `Season ${season[1]}`
  }

  const withoutTrailing = t.replace(TRAILING_COMPLETE_RE, '').replace(/\s+/g, ' ').trim()
  return titleCase(withoutTrailing || t)
}
