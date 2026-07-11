import { cn } from '../utils/cn.js'
import styles from './Avatar.module.css'

export function Avatar({ name, size = 40, status, className }) {
  const initial = (name || 'V').charAt(0).toUpperCase()
  const style = { '--size': `${size / 16}rem` }
  return (
    <div className={cn(styles.avatar, className)} style={style}>
      {initial}
      {status && (
        <span
          className={cn(
            styles.status,
            status === 'live' && styles.statusLive,
            status === 'online' && styles.statusOnline
          )}
        />
      )}
    </div>
  )
}
