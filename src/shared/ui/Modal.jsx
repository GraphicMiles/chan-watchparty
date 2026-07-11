import { useEffect } from 'react'
import { Card, IconButton } from './index.js'
import styles from './Modal.module.css'

export function Modal({ children, title, onClose, open }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.content} onClick={(e) => e.stopPropagation()}>
        <Card>
          <div className={styles.header}>
            <h2 className={styles.title}>{title}</h2>
            <IconButton onClick={onClose}>✕</IconButton>
          </div>
          {children}
        </Card>
      </div>
    </div>
  )
}
