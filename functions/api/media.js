/**
 * Cloudflare Pages Function - Media API
 * Maps to /api/media
 */
import { handler } from '../../api/media.js'

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context
  
  // Create mock req/res objects to adapt Vercel handler
  const req = {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: await request.json().catch(() => ({})),
    query: Object.fromEntries(new URL(request.url).searchParams),
  }
  
  let responseStatus = 200
  let responseHeaders = {}
  let responseBody = null
  
  const res = {
    status: (code) => { responseStatus = code; return res },
    setHeader: (key, value) => { responseHeaders[key] = value },
    writeHead: (code, headers) => { responseStatus = code; responseHeaders = { ...responseHeaders, ...headers } },
    end: (body) => { responseBody = body },
    send: (body) => { responseBody = typeof body === 'string' ? body : JSON.stringify(body) },
    json: (body) => { responseBody = JSON.stringify(body); responseHeaders['Content-Type'] = 'application/json' },
  }
  
  await handler(req, res)
  
  // Return proper Response object
  const headers = new Headers(responseHeaders)
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  
  return new Response(responseBody || JSON.stringify({ error: 'No response' }), {
    status: responseStatus,
    headers,
  })
}

export async function onRequestGet(context) {
  return onRequestPost(context)
}
