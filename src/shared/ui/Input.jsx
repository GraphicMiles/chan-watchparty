import { cn } from '../utils/cn.js'
import styles from './Input.module.css'

export function Input({ className, error, label, ...props }) {
  const input = (
    <input
      className={cn(styles.input, error && styles.error, className)}
      {...props}
    />
  )
  if (!label) return input
  return (
    <label className={styles.label}>
      {label}
      {input}
      {error && <span className={styles.errorText}>{error}</span>}
    </label>
  )
}
