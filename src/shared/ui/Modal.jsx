import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { IconButton } from './IconButton.jsx'
import styles from './Modal.module.css'

export function Modal({ children, title, icon: Icon, onClose, open }) {
  const contentRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
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
        <div className={styles.card}>
          <div className={styles.header}>
            <div className={styles.headerLeft}>
              {Icon && (
                <div className={styles.iconWrap}>
                  <Icon size={20} />
                </div>
              )}
              <h2 className={styles.title}>{title}</h2>
            </div>
            <IconButton onClick={onClose} aria-label="Close">
              <X size={18} />
            </IconButton>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}
