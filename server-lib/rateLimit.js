/**
 * In-memory rate limiter for Vercel Serverless Functions.
 *
 * Note: State resets on cold starts. For production-grade rate limiting
 * across all instances, use Upstash Redis or a similar persistent store.
 * This provides a meaningful first layer of defence regardless.
 */

const store = new Map()

/**
 * Check whether a request should be rate-limited.
 * @param {string} key  – Identifier (IP, UID, etc.)
 * @param {{ limit?: number, windowMs?: number }} opts
 * @returns {{ allowed: boolean, remaining: number }}
 */
export function checkRateLimit(key, { limit = 60, windowMs = 60_000 } = {}) {
  const now = Date.now()
  const record = store.get(key)

  if (!record || now > record.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, remaining: limit - 1 }
  }

  record.count++
  const allowed = record.count <= limit

  // Evict expired entries to bound memory
  if (store.size > 5000) {
    for (const [k, v] of store) {
      if (now > v.resetAt) store.delete(k)
    }
  }

  return { allowed, remaining: Math.max(0, limit - record.count) }
}

/** Derive a client key from the request (IP or forwarded-for). */
export function clientKey(req) {
  return (
    req.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers?.['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown'
  )
}
