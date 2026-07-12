import { cn } from '../utils/cn.js'
import styles from './IconButton.module.css'

export function IconButton({ children, className, active, ...props }) {
  return (
    <button className={cn(styles.button, active && styles.active, className)} {...props}>
      {children}
    </button>
  )
}
