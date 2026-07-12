import { useEffect, useState } from 'react'
import styles from './ConnectionBanner.module.css'

export function ConnectionBanner() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  const [firestoreState, setFirestoreState] = useState('unknown')

  useEffect(() => {
    const onOnline = () => setOnline(true)
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  useEffect(() => {
    // Best-effort Firestore connectivity signal via browser events + periodic probe.
    // Firestore itself doesn't expose a public "connected" boolean in modular web SDK.
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      if (!navigator.onLine) {
        setFirestoreState('offline')
        return
      }
      setFirestoreState('online')
    }
    tick()
    const id = window.setInterval(tick, 5000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  if (online && firestoreState !== 'offline') return null

  return (
    <div className={styles.banner} role="status">
      {online ? 'Reconnecting…' : 'You are offline. Changes will sync when the network returns.'}
    </div>
  )
}
