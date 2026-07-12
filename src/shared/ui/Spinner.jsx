import styles from './Spinner.module.css'

export function Spinner({ size = 20 }) {
  return <div className={styles.spinner} style={{ '--size': `${size / 16}rem` }} />
}
