import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { motion } from 'motion/react';
import { ease } from './motion';
import './AppShell.css';

export interface NavItem {
  index: string;
  label: string;
  /** Shorter label for the bottom bar under 720px. */
  short?: string;
  path: string;
  /** Mono figure on the right of the rail item (counts). */
  meta?: ReactNode;
  /** Draws a small accent dot: something here wants attention. */
  attention?: boolean;
}

export interface AppShellProps {
  nav: NavItem[];
  /** Bottom of the rail: mode, engine, model. */
  status?: ReactNode;
  /** Rendered outside the main column (e.g. the TraceRail). */
  overlay?: ReactNode;
  /** The right panel is open; on wide screens the main column makes room for it. */
  asideOpen?: boolean;
  children: ReactNode;
}

export function AppShell({ nav, status, overlay, asideOpen, children }: AppShellProps) {
  return (
    <div className={['shell', asideOpen && 'has-aside'].filter(Boolean).join(' ')}>
      <a href="#main" className="shell__skip">
        Skip to content
      </a>
      <div className="shell__drag" aria-hidden="true" />
      <nav className="rail" aria-label="Sections">
        <NavLink to="/" className="rail__brand" aria-label="Tack, start">
          <span className="rail__wordmark">Tack</span>
          <span className="rail__glyph" aria-hidden="true">
            T
          </span>
        </NavLink>
        <ol className="rail__list">
          {nav.map((item, i) => (
            <motion.li
              key={item.path}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.7, ease, delay: 0.05 + i * 0.04 }}
            >
              <NavLink to={item.path} end={item.path === '/'} className="rail__item" title={item.label}>
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <motion.span layoutId="rail-active" className="rail__active" transition={{ duration: 0.55, ease }} />
                    )}
                    <span className="rail__index t-num">{item.index}</span>
                    <span className="rail__label">{item.label}</span>
                    <span className="rail__short">{item.short ?? item.label}</span>
                    {item.attention && <span className="rail__attention" aria-label="needs attention" />}
                    {item.meta !== undefined && <span className="rail__meta t-num">{item.meta}</span>}
                  </>
                )}
              </NavLink>
            </motion.li>
          ))}
        </ol>
        {status && <div className="rail__status">{status}</div>}
      </nav>
      <main id="main" className="shell__main" tabIndex={-1}>
        <div className="shell__content">{children}</div>
      </main>
      {overlay}
    </div>
  );
}
