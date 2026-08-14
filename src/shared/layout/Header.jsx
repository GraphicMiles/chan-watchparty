import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { App } from '@capacitor/app'
import { VideoPlayerPlugin } from '../../native/VideoPlayerPlugin'
import { cn } from '../utils/cn.js'
import { Avatar } from '../ui/index.js'
import styles from './Header.module.css'

export function Header({ user, actions, className }) {
  // Exact APK identity from Gradle/CI. This prevents testing an old artifact
  // while assuming it contains the latest native-player change.
  const [buildInfo, setBuildInfo] = useState(null)
  useEffect(() => {
    let active = true
    VideoPlayerPlugin.getBuildInfo()
      .then((info) => { if (active) setBuildInfo(info) })
      .catch(() => {
        App.getInfo()
          .then((info) => { if (active) setBuildInfo({ version: info?.version || '', commit: '', builtAt: '' }) })
          .catch(() => {})
      })
    return () => { active = false }
  }, [])

  const built = buildInfo?.builtAt
    ? buildInfo.builtAt.replace('T', ' ').replace(/:\d{2}(?:\.\d+)?Z$/, 'Z')
    : ''
  const buildLabel = buildInfo?.version
    ? `v${buildInfo.version}${buildInfo.commit ? ` · ${buildInfo.commit}` : ''}${built ? ` · ${built}` : ''}`
    : ''

  return (
    <header className={cn(styles.header, className)}>
      <nav className={styles.nav}>
        <Link to="/" className={styles.logo}>
          <span className={styles.logoDots} />
          Chan
          {buildLabel ? <span className={styles.version}>{buildLabel}</span> : null}
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
