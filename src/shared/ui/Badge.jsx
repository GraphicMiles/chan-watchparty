import { cn } from '../utils/cn.js'
import styles from './Badge.module.css'

export function Badge({ children, variant = 'muted', icon: Icon, className, pulse }) {
  return (
    <span className={cn(styles.badge, styles[variant], pulse && styles.pulse, className)}>
      {Icon && (
        <span className={styles.icon}>
          <Icon />
        </span>
      )}
      {children}
    </span>
  )
}
