// Production API is Render. Ignore a leftover Vercel VITE_API_URL so the
// APK cannot keep calling a host that no longer matches resolve/proxy.
const RENDER_API = 'https://chan-aunk.onrender.com'
const fromEnv = String(import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')
export const API_URL = /onrender\.com/i.test(fromEnv) ? fromEnv : RENDER_API

export function apiPath(path) {
  const normalizedPath = String(path || '')
  if (!API_URL) return normalizedPath
  return `${API_URL}${normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`}`
}

export async function parseJsonResponse(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 160)
    throw new Error(`Server returned ${res.status} (not JSON): ${snippet}`)
  }
}
