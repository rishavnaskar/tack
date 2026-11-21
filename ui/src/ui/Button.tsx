import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Icon, type IconName } from './icons';
import './Button.css';

export type ButtonVariant = 'primary' | 'ghost' | 'quiet';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconLeft?: IconName;
  loading?: boolean;
  /** Renders a router link instead of a button. */
  to?: string;
  /** Renders a plain anchor (external links, downloads). */
  href?: string;
  download?: string | boolean;
  target?: string;
  block?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'ghost',
    size = 'md',
    icon,
    iconLeft,
    loading,
    to,
    href,
    download,
    target,
    block,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const cls = [
    'btn',
    `btn--${variant}`,
    `btn--${size}`,
    block && 'btn--block',
    loading && 'is-loading',
    !children && 'btn--icon-only',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const inner = (
    <>
      {iconLeft && <Icon name={iconLeft} size={size === 'sm' ? 15 : 17} />}
      {children && <span className="btn__text">{children}</span>}
      {icon && !loading && <Icon name={icon} size={size === 'sm' ? 15 : 17} className="btn__icon" />}
      {loading && <span className="btn__spinner" aria-hidden="true" />}
    </>
  );

  if (to && !disabled) {
    return (
      <Link to={to} className={cls} aria-label={rest['aria-label']}>
        {inner}
      </Link>
    );
  }
  if (href && !disabled) {
    return (
      <a
        href={href}
        className={cls}
        download={download}
        target={target}
        rel={target === '_blank' ? 'noreferrer' : undefined}
        aria-label={rest['aria-label']}
      >
        {inner}
      </a>
    );
  }
  return (
    <button
      ref={ref}
      type={type}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {inner}
    </button>
  );
});
