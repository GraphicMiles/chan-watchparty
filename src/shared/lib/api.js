export async function parseJsonResponse(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 160)
    throw new Error(`Server returned ${res.status} (not JSON): ${snippet}`)
  }
}
