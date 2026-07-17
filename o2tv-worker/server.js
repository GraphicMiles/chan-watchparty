/**
 * O2TV Resolve Worker — standalone HTTP service.
 *
 * Vercel Hobby hard-kills functions at 10s, but a single O2TV episode resolve
 * needs two captcha solves + two Groq vision calls (~5-9s cold). This worker
 * runs on Railway / Render / Fly / any host with no function-timeout cap and
 * exposes one endpoint the Vercel API proxies to.
 *
 * Endpoints:
 *   GET  /healthz            -> liveness (no auth)
 *   POST /resolve-episode    -> resolve an episode to a playable CDN MP4 (auth)
 *
 * Auth: all POST requests must send header X-Worker-Secret matching WORKER_SECRET.
 * Set WORKER_SECRET to the same value in both this worker's env and Vercel's.
 */

import http from 'node:http'
import { resolveO2TvEpisodeViaCaptcha } from './o2tvCaptchaResolver.js'

const PORT = Number(process.env.PORT) || 3001
const WORKER_SECRET = process.env.WORKER_SECRET
const MAX_RESOLVE_MS = Number(process.env.MAX_RESOLVE_MS) || 60000 // 60s hard cap per resolve

// Optional shared-secret gate. If unset, log a loud warning but still run
// (handy for local testing). In production ALWAYS set WORKER_SECRET.
function authorized(req) {
  if (!WORKER_SECRET) return true
  const sent = req.headers['x-worker-secret']
  return sent && sent === WORKER_SECRET
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1e6) { req.destroy(); reject(new Error('payload too large')) }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) }
      catch { reject(new Error('invalid JSON')) }
    })
    req.on('error', reject)
  })
}

// Hard deadline wrapper — never let a single resolve hang the worker forever.
function withDeadline(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)),
  ])
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    })
    return res.end()
  }

  // Health check (no auth — used by uptime monitors / Railway)
  if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/')) {
    return send(res, 200, {
      ok: true,
      service: 'o2tv-resolve-worker',
      groqConfigured: Boolean(process.env.GROQ_API_KEY),
      time: Date.now(),
    })
  }

  // Resolve endpoint
  if (req.method === 'POST' && (req.url === '/resolve-episode' || req.url === '/resolve')) {
    if (!authorized(req)) return send(res, 401, { error: 'Unauthorized: invalid or missing X-Worker-Secret' })

    let body
    try { body = await readJson(req) }
    catch (e) { return send(res, 400, { error: e.message }) }

    const showSlug = String(body.showSlug || '').trim()
    const showName = String(body.showName || '').trim()
    const seasonNum = Math.max(1, Number(body.seasonNum) || 1)
    const episodeNum = Math.max(1, Number(body.episodeNum) || 1)

    if (!showSlug && !showName) {
      return send(res, 400, { error: 'showSlug or showName is required' })
    }
    if (!process.env.GROQ_API_KEY) {
      return send(res, 503, { error: 'GROQ_API_KEY not configured on the worker' })
    }

    const slug = showSlug || showName.replace(/\s+/g, '-')
    const t0 = Date.now()
    console.log(`[resolve] ${slug} S${seasonNum}E${episodeNum}`)

    try {
      const results = await withDeadline(
        resolveO2TvEpisodeViaCaptcha(slug, seasonNum, episodeNum),
        MAX_RESOLVE_MS,
        'resolveO2TvEpisodeViaCaptcha',
      )
      const elapsed = Date.now() - t0

      if (results && results.length && results[0] && results[0].url) {
        console.log(`[resolve] ✅ ${slug} S${seasonNum}E${episodeNum} -> ${results[0].url.slice(0, 90)} (${elapsed}ms)`)
        return send(res, 200, {
          success: true,
          resolved: true,
          elapsedMs: elapsed,
          result: results[0],
        })
      }
      console.log(`[resolve] ❌ ${slug} S${seasonNum}E${episodeNum} no URL (${elapsed}ms)`)
      return send(res, 200, {
        success: false,
        resolved: false,
        elapsedMs: elapsed,
        error: 'Could not resolve this episode. Try another episode or quality.',
      })
    } catch (err) {
      const elapsed = Date.now() - t0
      console.error(`[resolve] ❌ ${slug} S${seasonNum}E${episodeNum} error (${elapsed}ms):`, err.message)
      return send(res, 200, {
        success: false,
        resolved: false,
        elapsedMs: elapsed,
        error: err.message,
      })
    }
  }

  return send(res, 404, { error: 'Not found' })
})

server.listen(PORT, () => {
  console.log(`o2tv-resolve-worker listening on :${PORT}`)
  console.log(`  GROQ_API_KEY: ${process.env.GROQ_API_KEY ? 'set' : 'NOT SET'}`)
  console.log(`  WORKER_SECRET: ${WORKER_SECRET ? 'set' : 'NOT SET (auth disabled — set for production)'}`)
})
