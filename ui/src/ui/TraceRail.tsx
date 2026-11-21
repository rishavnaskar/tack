import { useEffect, useLayoutEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { TraceEvent } from '../api/types';
import { Icon } from './icons';
import { ease } from './motion';
import './TraceRail.css';

export interface TraceRailProps {
  events: TraceEvent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A run is in progress: the tab dot pulses in accent. */
  active?: boolean;
  /** Label of the current long call, shown in the panel head. */
  activeLabel?: string;
  connected?: boolean;
  /** Events that arrived while closed; shown on the tab. */
  unseen?: number;
  onClear?: () => void;
}

const time = (at: string) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString('en-GB', { hour12: false });
};

const runName = (run: string) => run.replace(/-[a-z0-9]+$/i, '');

export function TraceRail({ events, open, onOpenChange, active, activeLabel, connected, unseen = 0, onClear }: TraceRailProps) {
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.overlay')) onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  return (
    <aside className={['trace', open && 'is-open'].filter(Boolean).join(' ')} aria-label="Agent trace">
      <button
        type="button"
        className={['trace__tab', active && 'is-active'].filter(Boolean).join(' ')}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls="trace-panel"
      >
        <span className={active ? 'pulse-dot' : 'trace__idle-dot'} />
        <span className="trace__tab-text">Trace</span>
        {unseen > 0 && !open && <span className="trace__unseen t-num">{unseen > 99 ? '99+' : unseen}</span>}
      </button>

      <div className="trace__panel" id="trace-panel" onPointerEnter={() => open && onOpenChange(true)}>
        <header className="trace__head">
          <div className="trace__titles">
            <span className="t-label">Agent trace</span>
            <span className="trace__now">
              {active ? (
                <>
                  <span className="pulse-dot" />
                  {activeLabel ?? 'Working'}
                </>
              ) : (
                <>
                  <span className="trace__idle-dot" />
                  Idle
                </>
              )}
            </span>
          </div>
          <div className="trace__tools">
            <span className={['trace__conn t-micro', connected && 'is-on'].filter(Boolean).join(' ')}>
              {connected ? 'Live' : 'Offline'}
            </span>
            {onClear && events.length > 0 && (
              <button type="button" className="trace__clear t-micro" onClick={onClear}>
                Clear
              </button>
            )}
            <button type="button" className="overlay__close" onClick={() => onOpenChange(false)} aria-label="Close trace">
              <Icon name="close" />
            </button>
          </div>
        </header>

        <div
          className="trace__list"
          ref={list}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {events.length === 0 ? (
            <div className="trace__empty">
              <span className="t-label">Nothing yet</span>
              <p>Steps from reading postings, building the gap map and planning show up here as they happen.</p>
            </div>
          ) : (
            <ol>
              <AnimatePresence initial={false}>
                {events.map((e, i) => {
                  const newRun = i === 0 || events[i - 1].run !== e.run;
                  return (
                    <motion.li
                      key={e.id}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.35, ease }}
                    >
                      {newRun && (
                        <div className="trace__run">
                          <span>{runName(e.run)}</span>
                          <span className="trace__run-rule" />
                          <span className="t-faint">{time(e.at)}</span>
                        </div>
                      )}
                      <div className={`trace__line is-${e.status}`}>
                        <span className="trace__time">{time(e.at).slice(3)}</span>
                        <span className="trace__step">{e.step}</span>
                        <span className="trace__detail">{e.detail}</span>
                        <span className="trace__ms">
                          {e.status === 'fail' ? 'fail' : e.ms ? `${e.ms}ms` : e.status === 'start' ? 'start' : 'ok'}
                        </span>
                      </div>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ol>
          )}
        </div>
      </div>
    </aside>
  );
}
