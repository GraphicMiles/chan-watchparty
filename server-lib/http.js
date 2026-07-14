import { sendResponse, buildHeaders } from './response.js'

export function corsHeadersForRequest(req) {
  return buildHeaders(req)
}

export const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export function preflight(req, res, { methods = ['GET', 'POST'] } = {}) {
  if (req.method === 'OPTIONS') {
    sendResponse(res, 200, { ok: true }, buildHeaders(req))
    return true
  }
  if (!methods.includes(req.method)) {
    sendResponse(res, 405, { error: `Method ${req.method} not allowed` }, buildHeaders(req))
    return true
  }
  return false
}

export function ok(res, body, status = 200) {
  sendResponse(res, status, { success: true, ...body })
}

export function fail(res, status, error) {
  sendResponse(res, status, { success: false, error })
}

export function statusForError(err) {
  if (err && typeof err.status === 'number') return err.status
  const message = String(err?.message || '')
  if (/not found/i.test(message)) return 404
  if (/unauthorized|invalid or expired token|missing token/i.test(message)) return 401
  if (/only the host|cannot kick|cannot mute|cannot change your own role/i.test(message)) return 403
  if (/missing|required|invalid|locked|full|invite code|ended/i.test(message)) return 400
  return 500
}
