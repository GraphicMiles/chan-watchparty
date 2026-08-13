import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { App } from '@capacitor/app'
import { cn } from '../utils/cn.js'
import { Avatar } from '../ui/index.js'
import styles from './Header.module.css'

export function Header({ user, actions, className }) {
  // Visible build marker so we can confirm WHICH build is running (debug APKs
  // install side-by-side with an old release as a separate app). Reads the
  // native versionName via Capacitor; blank on web.
  const [ver, setVer] = useState('')
  useEffect(() => {
    App.getInfo()
      .then((info) => setVer(info?.version || ''))
      .catch(() => setVer(''))
  }, [])

  return (
    <header className={cn(styles.header, className)}>
      <nav className={styles.nav}>
        <Link to="/" className={styles.logo}>
          <span className={styles.logoDots} />
          Chan
          {ver ? <span className={styles.version}>{`v${ver}`}</span> : null}
        </Link>
        <div className={styles.right}>
          {user && (
            <div className={styles.user}>
              <Avatar name={user.displayName || user.email} size={28} />
              <span className={styles.userName}>{user.displayName || 'Anonymous'}</span>
            </div>
          )}
          {actions}
        </div>
      </nav>
    </header>
  )
}
