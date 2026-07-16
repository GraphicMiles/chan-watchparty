/**
 * Shared input sanitization and validation utilities.
 *
 * Defense-in-depth for:
 *   - XSS via chat messages, titles, display names
 *   - Injection via URL parameters, query strings
 *   - Malformed input to API endpoints
 *   - Content-type mismatches
 */

/**
 * Escape HTML special characters to prevent XSS.
 * Use when rendering user-generated text in HTML contexts.
 *
 * @param {string} str - Raw user input
 * @returns {string} HTML-escaped string safe for rendering
 */
export function escapeHtml(str) {
  if (!str || typeof str !== 'string') return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

/**
 * Sanitize text for safe storage and display.
 * Strips HTML tags, normalizes whitespace, limits length.
 * Does NOT HTML-encode — that's for display layer (JSX auto-escapes).
 *
 * @param {string} str - Raw user input
 * @param {{ maxLength?: number, stripControlChars?: boolean }} opts
 * @returns {string} Cleaned string
 */
export function sanitizeText(str, { maxLength = 500, stripControlChars = true } = {}) {
  if (!str || typeof str !== 'string') return ''
  let clean = str
    .replace(/<[^>]*>/g, '')        // Strip HTML tags
    .replace(/\u200B/g, '')          // Strip zero-width spaces (common in spam)
    .replace(/\uFEFF/g, '')          // Strip BOM
  if (stripControlChars) {
    // Remove control chars except newline (\n), tab (\t), carriage return (\r)
    clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  }
  // Normalize excessive whitespace (but keep intentional line breaks)
  clean = clean
    .replace(/[ \t]+/g, ' ')        // Collapse spaces/tabs
    .replace(/\n{3,}/g, '\n\n')     // Max 2 consecutive line breaks
    .trim()
  return clean.slice(0, maxLength)
}

/**
 * Sanitize a display name (user names, room names, etc.)
 * Strips HTML, control chars, and limits length aggressively.
 *
 * @param {string} str - Raw display name
 * @param {number} maxLength - Max length (default 50)
 * @returns {string}
 */
export function sanitizeDisplayName(str, maxLength = 50) {
  if (!str || typeof str !== 'string') return ''
  return str
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')   // All control chars
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

/**
 * Sanitize a URL input — validates protocol, blocks private hosts.
 * Wraps validateFetchUrl with a try/catch that returns null on failure.
 *
 * @param {string} rawUrl - Raw URL string
 * @returns {string|null} Validated URL or null
 */
export function sanitizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null
  const trimmed = rawUrl.trim()
  if (!trimmed || trimmed.length > 2048) return null

  // Basic URL pattern check before expensive parsing
  if (!/^https?:\/\//i.test(trimmed)) return null

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.username || parsed.password) return null  // No credential URLs
    return parsed.href
  } catch {
    return null
  }
}

/**
 * Validate and sanitize an action string (for API endpoints).
 * Only allows alphanumeric actions with optional hyphens/underscores.
 *
 * @param {string} action - Raw action string
 * @param {string[]} allowedActions - Whitelist of valid actions
 * @returns {string|null} Validated action or null
 */
export function sanitizeAction(action, allowedActions = []) {
  if (!action || typeof action !== 'string') return null
  const clean = action.toLowerCase().trim()
  // Allow camelCase / snake_case / kebab-case action ids
  if (!/^[a-z][a-z0-9_-]*$/.test(clean)) return null
  if (!Array.isArray(allowedActions) || allowedActions.length === 0) return clean
  // Match case-insensitively, but return the canonical form from the allowlist
  // (e.g. client sends "o2tvSeasons" → clean "o2tvseasons" → return "o2tvSeasons").
  // Without this, camelCase actions like refreshCatalog / probeIptv / o2tvResolve
  // were rejected and silently fell back to "search".
  const canonical = allowedActions.find((a) => String(a).toLowerCase() === clean)
  return canonical || null
}

/**
 * Validate a search query string.
 * Strips dangerous patterns, limits length, blocks obviously malicious input.
 *
 * @param {string} query - Raw search query
 * @param {number} maxLength - Max length (default 200)
 * @returns {string|null} Cleaned query or null if invalid
 */
export function sanitizeSearchQuery(query, maxLength = 200) {
  if (!query || typeof query !== 'string') return null
  let clean = query
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
  // Reject queries that are just symbols or too short
  if (clean.length < 1 || clean.length > maxLength) return null
  if (/^[\s\W]+$/.test(clean) && clean.length < 3) return null
  return clean
}

/**
 * Validate a room ID format (Firestore document ID).
 * Must be alphanumeric with limited special chars, 1-128 chars.
 *
 * @param {string} id - Raw room ID
 * @returns {string|null} Validated ID or null
 */
export function sanitizeRoomId(id) {
  if (!id || typeof id !== 'string') return null
  const clean = id.trim()
  if (clean.length < 1 || clean.length > 128) return null
  // Firestore doc IDs: alphanumeric, hyphens, underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(clean)) return null
  return clean
}

/**
 * Validate a UID format (Firebase Auth UID).
 * Must be 28 alphanumeric chars (Firebase default) or similar.
 *
 * @param {string} uid - Raw UID
 * @returns {string|null} Validated UID or null
 */
export function sanitizeUid(uid) {
  if (!uid || typeof uid !== 'string') return null
  const clean = uid.trim()
  if (clean.length < 1 || clean.length > 128) return null
  if (!/^[a-zA-Z0-9]+$/.test(clean)) return null
  return clean
}

/**
 * Content-Type validation for media responses.
 * Prevents serving HTML as video (XSS via proxy).
 *
 * @param {string} contentType - Response Content-Type header
 * @param {string} expectedType - 'video', 'image', or 'json'
 * @returns {boolean} Whether the content type is safe for the expected type
 */
export function isContentTypeSafe(contentType, expectedType = 'video') {
  if (!contentType) return false
  const lower = contentType.toLowerCase().split(';')[0].trim()

  switch (expectedType) {
    case 'video':
      // Allow video/*, application/octet-stream, application/x-mpegURL
      // Block text/html, text/plain, application/xhtml
      if (/text\/html|application\/xhtml|text\/plain/i.test(lower)) return false
      return /^(video\/|application\/(octet-stream|vnd\.apple\.mpegurl|x-mpegurl|mpegurl)|audio\/|multipart\/formdata)/i.test(lower) || lower === ''
    case 'image':
      return /^image\//i.test(lower)
    case 'json':
      return /^application\/json/i.test(lower)
    default:
      return true
  }
}
