const PALETTE = [
  '#7C89F7',
  '#FF6B47',
  '#34D399',
  '#FBBF24',
  '#A78BFA',
  '#38BDF8',
  '#FB7185',
  '#2DD4BF',
]

/** Deterministic avatar color from a stable id (uid preferred). */
export function avatarColor(seed = '') {
  const str = String(seed || 'viewer')
  let hash = 0
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0
  }
  return PALETTE[hash % PALETTE.length]
}
