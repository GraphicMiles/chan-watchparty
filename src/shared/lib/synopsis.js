/**
 * Shared synopsis contract.
 *
 * Why this exists: the room doc's `synopsis` is the single field RoomPage
 * renders under the player (shared by every viewer). Sources produce
 * descriptions of wildly different quality (Nkiri page extract, YouTube
 * snippet, Groq fallback, ad-copy). We keep a short, clean string or null
 * — never junk, never an empty field that would overwrite a good one.
 *
 * The 20-char floor is intentional: titles like "Episode 1" and "Download"
 * must not become the room synopsis. The 600-char cap matches the Firestore
 * room payload and the mockup 2-line clamp.
 */
export function sanitizeSynopsis(value) {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length < 20) return null
  return text.slice(0, 600)
}

/** Groq fallbacks hedge ("appears to be", "likely features"). Page extracts do not. */
export function looksLikeAiSynopsis(text) {
  return /\b(appears to be|it likely|may introduce|it may |this appears|inferred|probably features)\b/i.test(String(text || ''))
}
