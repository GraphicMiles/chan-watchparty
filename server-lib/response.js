import { corsHeaders } from './cors.js'

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
}

export function sendResponse(res, status, body, headers = {}) {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...SECURITY_HEADERS,
    ...headers,
  })
  res.end(json)
}

/** Build full response headers merging CORS + security + custom. */
export function buildHeaders(req, extra = {}) {
  return { ...corsHeaders(req), ...SECURITY_HEADERS, ...extra }
}
