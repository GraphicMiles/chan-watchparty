import { API_URL } from './api.js'

const DEFAULT_PUBLIC_ORIGIN = 'https://chan-aunk.onrender.com'
const APP_HOSTS = new Set([
  'chan-aunk.onrender.com',
  'chan-yz3p.vercel.app',
])
const SIMPLE_ROUTES = new Set([
  '/',
  '/auth',
  '/search',
  '/media',
  '/title',
  '/create',
  '/profile',
  '/scraper',
])
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{1,32}$/

function cleanInviteCode(value) {
  const code = String(value || '').trim().toUpperCase()
  return INVITE_CODE_RE.test(code) ? code : ''
}

function inviteFromParams(params) {
  return cleanInviteCode(
    params.get('invite') || params.get('inviteCode') || params.get('code') || ''
  )
}

function roomPath(roomId, params = new URLSearchParams()) {
  const id = String(roomId || '').trim()
  if (!ROOM_ID_RE.test(id)) return null
  const invite = inviteFromParams(params)
  return `/room/${encodeURIComponent(id)}${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`
}

function safeRoute(pathname, searchParams = new URLSearchParams()) {
  let path = String(pathname || '/').trim() || '/'
  if (!path.startsWith('/')) path = `/${path}`
  if (path.length > 1) path = path.replace(/\/+$/, '')

  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'room') {
    if (parts.length !== 2) return '/'
    try {
      return roomPath(decodeURIComponent(parts[1]), searchParams) || '/'
    } catch {
      return '/'
    }
  }

  if (!SIMPLE_ROUTES.has(path)) return '/'
  const query = searchParams.toString()
  return query ? `${path}?${query}` : path
}

export function publicWebOrigin() {
  const configured = String(import.meta.env?.VITE_PUBLIC_ORIGIN || '').replace(/\/+$/, '')
  try {
    const url = new URL(configured)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && APP_HOSTS.has(url.hostname)) {
      return url.origin
    }
  } catch {
    /* fall through to the canonical public host */
  }

  if (typeof window !== 'undefined' && APP_HOSTS.has(window.location.hostname)) {
    return window.location.origin
  }

  try {
    const api = new URL(API_URL)
    if (APP_HOSTS.has(api.hostname)) return api.origin
  } catch {
    /* use the production default below */
  }
  return DEFAULT_PUBLIC_ORIGIN
}

export function buildRoomLink(roomId, inviteCode = '') {
  const params = new URLSearchParams()
  const code = cleanInviteCode(inviteCode)
  if (code) params.set('invite', code)
  const path = roomPath(roomId, params) || '/'
  return new URL(path, publicWebOrigin()).toString()
}

export function parseDeepLink(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null
  const raw = rawUrl.trim()

  try {
    if (raw.startsWith('/')) {
      const relative = new URL(raw, DEFAULT_PUBLIC_ORIGIN)
      return safeRoute(relative.pathname, relative.searchParams)
    }

    const url = new URL(raw)

    if (url.protocol === 'chan:') {
      if (url.hostname === 'room') {
        const parts = url.pathname.split('/').filter(Boolean)
        if (parts.length !== 1) return null
        try {
          return roomPath(decodeURIComponent(parts[0]), url.searchParams)
        } catch {
          return null
        }
      }
      if (url.hostname === 'join' || url.hostname === 'invite') {
        return roomPath(url.searchParams.get('room') || url.searchParams.get('roomId'), url.searchParams)
      }
      if (!url.hostname) return safeRoute(url.pathname, url.searchParams)
      return null
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

    const host = url.hostname.toLowerCase()
    const isCapacitorLocalHost = host === 'localhost'
      && typeof window !== 'undefined'
      && window.location.hostname === 'localhost'
    if (!APP_HOSTS.has(host) && !isCapacitorLocalHost) return null

    return safeRoute(url.pathname, url.searchParams)
  } catch {
    return null
  }
}

export function deepLinkPathFromNotification(notification) {
  const data = notification?.notification?.data || notification?.data || notification || {}
  if (typeof data.path === 'string' && data.path) return parseDeepLink(data.path)
  if (typeof data.url === 'string' && data.url) return parseDeepLink(data.url)
  if (typeof data.roomId === 'string' && data.roomId) {
    const params = new URLSearchParams()
    const invite = cleanInviteCode(data.invite || data.inviteCode || data.code)
    if (invite) params.set('invite', invite)
    return roomPath(data.roomId, params)
  }
  return null
}
