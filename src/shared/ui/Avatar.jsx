import { cn } from '../utils/cn.js'
import { avatarColor } from '../utils/avatarColor.js'
import styles from './Avatar.module.css'

export function Avatar({ name, uid, size = 40, status, className }) {
  const initial = (name || 'V').charAt(0).toUpperCase()
  const bg = avatarColor(uid || name || 'viewer')
  const style = {
    '--size': `${size / 16}rem`,
    background: bg,
  }
  return (
    <div className={cn(styles.avatar, className)} style={style} title={name || undefined}>
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
