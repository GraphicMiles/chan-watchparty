/**
 * resolveCache — in-memory TTL cache for media resolution (Phase A).
 *
 * Keyed by the episode PAGE URL (sourceUrl) so a fresh token can always be
 * regenerated. Negative cache prevents hammering dead hosts (cooldown).
 *
 * Single-instance in-memory is correct for Render's free/standard single
 * instance; swap the internals for Redis when multi-instance scaling is needed.
 */

const POSITIVE_TTL_MS = 4 * 60 * 60 * 1000 // conservative; DownloadWella tokens are long-lived
const NEGATIVE_TTL_MS = 5 * 60 * 1000 // cooldown for dead hosts

const store = new Map() // key -> { exp, value }
const negative = new Map() // key -> { exp, value }

export function cacheKeyFor(sourceUrl) {
  return `dw:${String(sourceUrl || '').trim()}`
}

export function cacheGet(key) {
  const entry = store.get(key)
  if (!entry) return null
  if (Date.now() > entry.exp) {
    store.delete(key)
    return null
  }
  return entry.value
}

export function cacheSet(key, value, ttlMs = POSITIVE_TTL_MS) {
  store.set(key, { value, exp: Date.now() + ttlMs })
}

export function cacheDelete(key) {
  store.delete(key)
}

export function negativeGet(key) {
  const entry = negative.get(key)
  if (!entry) return null
  if (Date.now() > entry.exp) {
    negative.delete(key)
    return null
  }
  return entry.value
}

export function negativeSet(key, value, ttlMs = NEGATIVE_TTL_MS) {
  negative.set(key, { value, exp: Date.now() + ttlMs })
}

export function cacheStats() {
  return { size: store.size, negativeSize: negative.size }
}
