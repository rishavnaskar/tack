import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './icons';
import { ease } from './motion';
import './Overlay.css';

function useOverlay(open: boolean, onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === 'Tab' && panel.current) {
        const nodes = panel.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])',
        );
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = window.setTimeout(() => panel.current?.focus(), 30);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open]);

  return panel;
}

function useNarrow(query = '(max-width: 719px)') {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Mono micro-label above the title. */
  eyebrow?: ReactNode;
  /** Right side of the header, next to the close button. */
  actions?: ReactNode;
  footer?: ReactNode;
  width?: number;
  children: ReactNode;
}

export function Drawer({ open, onClose, title, eyebrow, actions, footer, width = 560, children }: DrawerProps) {
  const panel = useOverlay(open, onClose);
  const narrow = useNarrow();
  const from = narrow ? { y: '100%', x: 0 } : { x: '100%', y: 0 };

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="overlay overlay--drawer" key="drawer">
          <motion.div
            className="overlay__scrim"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease }}
          />
          <motion.div
            ref={panel}
            className="drawer"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            style={{ ['--drawer-w' as string]: `${width}px` }}
            initial={from}
            animate={{ x: 0, y: 0 }}
            exit={from}
            transition={{ duration: 0.6, ease }}
          >
            <header className="drawer__head">
              <div className="drawer__titles">
                {eyebrow && <span className="t-label">{eyebrow}</span>}
                <h2 className="drawer__title">{title}</h2>
              </div>
              <div className="drawer__actions">
                {actions}
                <button type="button" className="overlay__close" onClick={onClose} aria-label="Close">
                  <Icon name="close" />
                </button>
              </div>
            </header>
            <div className="drawer__body">{children}</div>
            {footer && <footer className="drawer__foot">{footer}</footer>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  eyebrow?: ReactNode;
  footer?: ReactNode;
  width?: number;
  children: ReactNode;
}

export function Modal({ open, onClose, title, eyebrow, footer, width = 520, children }: ModalProps) {
  const panel = useOverlay(open, onClose);
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="overlay overlay--modal" key="modal">
          <motion.div
            className="overlay__scrim"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease }}
          />
          <motion.div
            ref={panel}
            className="modal"
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            style={{ ['--modal-w' as string]: `${width}px` }}
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.99 }}
            transition={{ duration: 0.5, ease }}
          >
            <header className="modal__head">
              <div className="drawer__titles">
                {eyebrow && <span className="t-label">{eyebrow}</span>}
                <h2 className="modal__title">{title}</h2>
              </div>
              <button type="button" className="overlay__close" onClick={onClose} aria-label="Close">
                <Icon name="close" />
              </button>
            </header>
            <div className="modal__body">{children}</div>
            {footer && <footer className="modal__foot">{footer}</footer>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export { useNarrow };
