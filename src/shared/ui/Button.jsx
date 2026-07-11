import { cn } from '../utils/cn.js'
import { Spinner } from './Spinner.jsx'
import styles from './Button.module.css'

export function Button({
  children,
  as: Component = 'button',
  variant = 'primary',
  size = 'md',
  fullWidth,
  loading = false,
  disabled,
  className,
  ...props
}) {
  const isDisabled = disabled || loading
  const classes = cn(
    styles.button,
    styles[variant],
    styles[size],
    fullWidth && styles.fullWidth,
    loading && styles.loading,
    className
  )
  return (
    <Component className={classes} disabled={isDisabled} aria-busy={loading || undefined} {...props}>
      {loading && <Spinner size={size === 'sm' ? 14 : 18} />}
      <span className={loading ? styles.labelHidden : undefined}>{children}</span>
    </Component>
  )
}
