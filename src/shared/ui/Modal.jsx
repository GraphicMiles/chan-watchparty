import { useEffect, useRef } from 'react'
import { Card } from './Card.jsx'
import { IconButton } from './IconButton.jsx'
import styles from './Modal.module.css'

export function Modal({ children, title, onClose, open }) {
  const contentRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    // Focus first focusable control inside modal
    const root = contentRef.current
    const focusable = root?.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    focusable?.focus?.()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className={styles.overlay} onClick={onClose} role="presentation">
      <div
        className={styles.content}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Dialog'}
        ref={contentRef}
      >
        <Card>
          <div className={styles.header}>
            <h2 className={styles.title}>{title}</h2>
            <IconButton onClick={onClose} aria-label="Close">✕</IconButton>
          </div>
          {children}
        </Card>
      </div>
    </div>
  )
}
