export function isSuitableThumbnail(url) {
  if (!url || typeof url !== 'string') return false
  const clean = url.trim().toLowerCase()
  if (!clean || clean.startsWith('data:') || clean === 'null' || clean === 'undefined') return false
  // Always keep Nkiri / common poster CDNs (real show art)
  if (/thenkiri|nkiri\.com|pbcdnw|aoneroom|omdbapi|img\.omdb|m\.media-amazon|ia\.media-imdb|archive\.org\/services\/img/i.test(clean)) {
    return /^https?:\/\//i.test(url.trim())
  }
  if (clean.includes('downloadwella.com') || clean.includes('downloadwella')) return false
  if (clean.includes('np-downloader.com') || clean.includes('wildshare.net')) return false
  if (clean.includes('fsmc') || clean.includes('kissorgrab') || clean.includes('meetdownload')) return false
  if (/\b(arrow|download|logo|icon|placeholder|default|avatar|gravatar|spinner|loading|no-image|missing|blank|button|1x1|pixel)(\.|-|_|\b)/i.test(clean)) return false
  if (clean.endsWith('.svg') || clean.endsWith('.ico')) return false
  return /^https?:\/\//i.test(url.trim())
}

export function cleanTitleForMatching(str) {
  if (!str) return ''
  return String(str)
    .replace(/\b(nkiri|thenkiri|netnaija|thenetnaija|mynetnaija|fzmovies|9jarocks|animedrive|o2tvseries|o2tv|downloadwella|tvshows4mobile|naijaprey|fztvseries|wideshares|archiveorg|meetdownload|waploaded|maxcinema|koyeb|webrip|hdrip|bluray|brrip|720p|1080p|2160p|4k|x264|h264|x265|hevc|mp4|mkv|avi|m3u8|webm)\b/gi, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\.(mp4|mkv|m3u8|avi|mov)$/i, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .toLowerCase()
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

  if (tClean === qClean) return true

  const phraseRegex = new RegExp('\\b' + qClean.replace(/\s+/g, '\\s+') + '\\b', 'i')
  if (phraseRegex.test(tClean)) return true

  const qNoSpaces = qClean.replace(/\s+/g, '')
  const tNoSpaces = tClean.replace(/\s+/g, '')
  if (qNoSpaces.length >= 4) {
    if (tNoSpaces === qNoSpaces || new RegExp('\\b' + qNoSpaces + '\\b', 'i').test(tClean) || new RegExp('\\b' + qNoSpaces + '\\b', 'i').test(tNoSpaces)) {
      return true
    }
  }

  const qTokens = qClean.split(/\s+/).filter(t => t.length >= 2 && !['of', 'the', 'in', 'at', 'to', 'and', 'for', 'with', 'by', 'from', 'on', 'or', 'a', 'an'].includes(t))
  if (qTokens.length >= 2) {
    const allQueryTokensInTitle = qTokens.every(token => new RegExp('\\b' + token + '\\b', 'i').test(tClean))
    if (allQueryTokensInTitle) {
      return true
    }
  }

  return false
}
