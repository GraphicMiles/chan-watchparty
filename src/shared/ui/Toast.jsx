import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react'
import styles from './Toast.module.css'

const ToastContext = createContext(null)

let toastId = 0

const ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback((message, options = {}) => {
    const id = ++toastId
    const variant = options.variant || 'info'
    const duration = options.duration ?? 4000
    setToasts((list) => [...list.slice(-4), { id, message, variant }])
    if (duration > 0) {
      window.setTimeout(() => dismiss(id), duration)
    }
    return id
  }, [dismiss])

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.viewport} aria-live="polite" aria-relevant="additions">
        {toasts.map((t) => {
          const Icon = ICONS[t.variant] || Info
          return (
            <div key={t.id} className={`${styles.toast} ${styles[t.variant]}`} role="status">
              <Icon size={18} className={styles.icon} />
              <span className={styles.message}>{t.message}</span>
              <button type="button" className={styles.close} onClick={() => dismiss(t.id)} aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    return {
      toast: (message) => {
        console.warn('ToastProvider missing:', message)
      },
      dismiss: () => {},
    }
  }
  return ctx
}
