// Capacitor/Android must hit the Render API — a blank VITE_API_URL becomes
// https://localhost/api/... and resolve/proxy silently fail in the WebView.
const DEFAULT_API = 'https://chan-aunk.onrender.com'
export const API_URL = String(import.meta.env.VITE_API_URL || DEFAULT_API).replace(/\/+$/, '')

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
