export function SyncPulse({ active = true, size = 40, className = '' }) {
  const prefersReduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const ringStyle = {
    width: size,
    height: size,
    borderRadius: '50%',
    border: '2px solid var(--ember)',
    position: 'absolute',
    inset: 0,
    opacity: prefersReduced ? 0.6 : 0.8,
  }
  return (
    <div
      className={className}
      style={{ position: 'relative', width: size, height: size, borderRadius: '50%', overflow: 'visible' }}
    >
      <div style={ringStyle} className={active && !prefersReduced ? 'sync-pulse' : ''} />
    </div>
  )
}
