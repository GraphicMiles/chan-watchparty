export const API_URL = String(import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')

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
