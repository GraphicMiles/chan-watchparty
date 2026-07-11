import { cn } from '../utils/cn.js'
import styles from './Button.module.css'

export function Button({ children, as: Component = 'button', variant = 'primary', size = 'md', fullWidth, className, ...props }) {
  const classes = cn(
    styles.button,
    styles[variant],
    styles[size],
    fullWidth && styles.fullWidth,
    className
  )
  return (
    <Component className={classes} {...props}>
      {children}
    </Component>
  )
}
