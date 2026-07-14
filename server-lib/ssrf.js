/**
 * Shared SSRF (Server-Side Request Forgery) validation.
 *
 * Single source of truth for URL safety checks used by
 * api/proxy, api/media, and any future outbound-fetch code.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const PRIVATE_IPV4_RE = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|0\.0\.0\.0)/

/**
 * Check whether a hostname resolves to a private / loopback address.
 * Works for textual representations; does NOT perform DNS resolution
 * (use with DNS-rebinding awareness — always re-validate after redirects).
 */
export function isPrivateHost(hostname) {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (lower === 'localhost' || lower.endsWith('.localhost') || lower === '::1') {
    return true
  }
  if (PRIVATE_IPV4_RE.test(lower)) {
    return true
  }
  // Additional .local mDNS check
  if (lower.endsWith('.local')) {
    return true
  }
  return false
}

/**
 * Validate a URL for outbound server-side fetching.
 * Throws descriptive errors on policy violations.
 *
 * @param {string} rawUrl  – The URL to validate.
 * @param {{ allowCredentials?: boolean }} opts – allowCredentials permits user:pass@ URLs.
 * @returns {URL} Parsed URL if valid.
 */
export function validateFetchUrl(rawUrl, { allowCredentials = false } = {}) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid or malformed URL')
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are allowed')
  }

  if (!allowCredentials && (parsed.username || parsed.password)) {
    throw new Error('URLs with embedded credentials are not allowed')
  }

  if (isPrivateHost(parsed.hostname)) {
    throw new Error('Private and local network targets are forbidden')
  }

  return parsed
}
