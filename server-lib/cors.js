/**
 * CORS origin validation.
 *
 * If the `ALLOWED_ORIGINS` env var is set (JSON array of origin strings),
 * only those origins (plus localhost variants) are allowed.
 * If unset, falls back to `*` for backward compatibility.
 */

const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

function allowlist() {
  if (!process.env.ALLOWED_ORIGINS) return null // null = allow all
  try {
    const parsed = JSON.parse(process.env.ALLOWED_ORIGINS)
    if (Array.isArray(parsed) && parsed.length) return parsed
  } catch { /* ignore */ }
  return null
}

/**
 * Return the value to set for `Access-Control-Allow-Origin`,
 * or `null` to deny the request entirely.
 */
export function resolveOrigin(req) {
  const origin = req.headers?.origin || req.headers?.Origin
  if (!origin) return '*' // server-to-server / curl

  const list = allowlist()
  if (!list) return '*' // no allowlist configured → permissive (backward compat)

  if (LOCAL_RE.test(origin)) return origin
  if (list.includes(origin)) return origin

  return null // blocked
}

export function corsHeaders(req) {
  const origin = resolveOrigin(req)
  if (!origin) {
    return {
      'Access-Control-Allow-Origin': 'null',
    }
  }
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Cron-Secret',
  }
  if (origin !== '*') {
    headers['Access-Control-Allow-Credentials'] = 'true'
  }
  return headers
}
