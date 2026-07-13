import { cn } from '../utils/cn.js'
import styles from './IconButton.module.css'

export function IconButton({ children, className, active, size = 36, ...props }) {
  return (
    <button
      className={cn(styles.button, active && styles.active, className)}
      style={{ width: size, height: size }}
      {...props}
    >
      {children}
    </button>
  )
}
