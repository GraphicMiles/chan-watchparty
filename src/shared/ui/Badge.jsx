import { cn } from '../utils/cn.js'
import styles from './Badge.module.css'

export function Badge({ children, variant = 'muted', className }) {
  return <span className={cn(styles.badge, styles[variant], className)}>{children}</span>
}
