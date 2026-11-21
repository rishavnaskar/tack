import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './icons';
import { ease } from './motion';
import './Toast.css';

export interface ToastInput {
  title: ReactNode;
  body?: ReactNode;
  tone?: 'default' | 'success' | 'error';
  action?: { label: string; onClick: () => void };
  /** ms; 0 keeps it until dismissed */
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<((t: ToastInput) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (t: ToastInput) => {
      const id = ++seq.current;
      setItems((all) => [...all.slice(-2), { ...t, id }]);
      const ms = t.duration ?? (t.tone === 'error' ? 7000 : 4500);
      if (ms > 0) window.setTimeout(() => dismiss(id), ms);
    },
    [dismiss],
  );

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.div
              key={t.id}
              layout
              className={`toast toast--${t.tone ?? 'default'}`}
              initial={{ opacity: 0, y: 16, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, transition: { duration: 0.25 } }}
              transition={{ duration: 0.5, ease }}
              role={t.tone === 'error' ? 'alert' : 'status'}
            >
              <span className="toast__mark" aria-hidden="true">
                {t.tone === 'error' ? <Icon name="warning" size={15} /> : t.tone === 'success' ? <Icon name="check" size={15} /> : <span className="toast__dot" />}
              </span>
              <div className="toast__text">
                <span className="toast__title">{t.title}</span>
                {t.body && <span className="toast__body">{t.body}</span>}
              </div>
              {t.action && (
                <button
                  type="button"
                  className="toast__action"
                  onClick={() => {
                    t.action?.onClick();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button type="button" className="toast__close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <Icon name="close" size={14} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast needs a ToastProvider');
  return ctx;
}
