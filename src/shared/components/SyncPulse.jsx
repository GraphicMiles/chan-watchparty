import styles from './SyncPulse.module.css'

export function SyncPulse({ active = true, size = 40, className = '' }) {
  const prefersReduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  return (
    <div
      className={`${className} ${styles.wrap}`}
      style={{ width: size, height: size }}
    >
      <div
        className={`${styles.ring} ${active && !prefersReduced ? 'sync-pulse' : ''}`}
        style={{
          borderRadius: '50%',
          border: '2px solid var(--live-red)',
          position: 'absolute',
          inset: 0,
          opacity: prefersReduced ? 0.5 : 0.8,
        }}
      />
    </div>
  )
}
