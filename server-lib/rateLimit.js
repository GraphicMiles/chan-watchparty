/**
 * Persistent Rate Limiter using Upstash Redis
 *
 * Falls back to in-memory rate limiting when Redis is not configured.
 * Redis provides rate limiting that survives cold starts and works
 * across multiple Vercel function instances.
 *
 * Environment variables:
 *   UPSTASH_REDIS_REST_URL  - Upstash Redis REST URL
 *   UPSTASH_REDIS_REST_TOKEN - Upstash Redis REST token
 *
 * Uses sliding window counter algorithm:
 *   - Maintains a current and previous window counter
 *   - Weighted sum gives smooth rate estimation
 *   - Atomic Redis operations prevent race conditions
 */

import { Redis } from '@upstash/redis'

let _redis = null
let _redisInitAttempted = false

// In-memory fallback (same as before)
const memoryStore = new Map()

/**
 * Get or initialize the Redis client
 * Returns null if Redis is not configured
 */
function getRedis() {
  if (_redisInitAttempted) return _redis
  _redisInitAttempted = true

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN

  if (url && token) {
    try {
      _redis = new Redis({ url, token })
      console.log('[rateLimit] Upstash Redis configured — using persistent rate limiting')
    } catch (err) {
      console.error('[rateLimit] Failed to initialize Redis:', err.message)
      _redis = null
    }
  } else {
    console.log('[rateLimit] No Upstash Redis configured — using in-memory rate limiting (resets on cold starts)')
  }

  return _redis
}

/**
 * Check whether a request should be rate-limited.
 *
 * Uses Redis sliding window when available, in-memory otherwise.
 *
 * @param {string} key  – Identifier (IP, UID, etc.)
 * @param {{ limit?: number, windowMs?: number }} opts
 * @returns {Promise<{ allowed: boolean, remaining: number }>}
 */
export async function checkRateLimit(key, { limit = 60, windowMs = 60_000 } = {}) {
  const redis = getRedis()

  if (redis) {
    return checkRedisRateLimit(redis, key, { limit, windowMs })
  }

  // In-memory fallback (synchronous, but wrapped in Promise for consistent API)
  return checkMemoryRateLimit(key, { limit, windowMs })
}

/**
 * Redis-based sliding window rate limit.
 * Uses two keys per window: current and previous.
 * Weighted sum provides smooth transitions between windows.
 */
async function checkRedisRateLimit(redis, key, { limit, windowMs }) {
  const now = Date.now()
  const windowSec = Math.ceil(windowMs / 1000)
  const currentWindow = Math.floor(now / windowMs)
  const previousWindow = currentWindow - 1

  const currentKey = `rl:${key}:${currentWindow}`
  const previousKey = `rl:${key}:${previousWindow}`

  try {
    // Atomically increment current window and get both counters
    const [currentCount, previousCount] = await redis
      .multi()
      .incr(currentKey)
      .get(previousKey)
      .exec()

    // Set TTL on current window key (only on first increment)
    if (currentCount === 1) {
      await redis.expire(currentKey, windowSec * 2).catch(() => {})
    }

    // Calculate weighted request count
    const elapsed = (now % windowMs) / windowMs  // 0..1
    const previousWeight = 1 - elapsed
    const previousNum = Number(previousCount) || 0
    const estimated = previousNum * previousWeight + Number(currentCount)

    const allowed = estimated <= limit
    const remaining = Math.max(0, limit - Math.floor(estimated))

    return { allowed, remaining }
  } catch (err) {
    console.error('[rateLimit] Redis error, falling back to memory:', err.message)
    return checkMemoryRateLimit(key, { limit, windowMs })
  }
}

/**
 * In-memory rate limit (fallback).
 * Resets on cold starts. Bounded to 5000 entries.
 */
function checkMemoryRateLimit(key, { limit, windowMs }) {
  const now = Date.now()
  const record = memoryStore.get(key)

  if (!record || now > record.resetAt) {
    memoryStore.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, remaining: limit - 1 }
  }

  record.count++
  const allowed = record.count <= limit

  // Evict expired entries to bound memory
  if (memoryStore.size > 5000) {
    for (const [k, v] of memoryStore) {
      if (now > v.resetAt) memoryStore.delete(k)
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
