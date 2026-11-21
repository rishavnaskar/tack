import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Icon, type IconName } from './icons';
import { ease } from './motion';
import './Tabs.css';

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  count?: number;
  icon?: IconName;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** "pill" is a segmented control; "line" is an underlined row. */
  variant?: 'pill' | 'line';
  size?: 'sm' | 'md';
  'aria-label'?: string;
  className?: string;
}

export function Tabs<T extends string>({ items, value, onChange, variant = 'pill', size = 'md', className, ...aria }: TabsProps<T>) {
  const uid = useId();
  const list = useRef<HTMLDivElement>(null);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const enabled = items.filter((i) => !i.disabled);
    const at = enabled.findIndex((i) => i.id === value);
    const next = enabled[(at + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
    onChange(next.id);
    const btn = list.current?.querySelector<HTMLButtonElement>(`[data-id="${next.id}"]`);
    btn?.focus();
  };

  return (
    <div
      ref={list}
      role="tablist"
      aria-label={aria['aria-label']}
      className={['tabs', `tabs--${variant}`, `tabs--${size}`, className].filter(Boolean).join(' ')}
      onKeyDown={onKey}
    >
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            data-id={item.id}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={item.disabled}
            className={['tabs__tab', active && 'is-active'].filter(Boolean).join(' ')}
            onClick={() => onChange(item.id)}
          >
            {active && (
              <motion.span
                layoutId={`tabs-${uid}`}
                className="tabs__indicator"
                transition={{ duration: 0.5, ease }}
              />
            )}
            <span className="tabs__label">
              {item.icon && <Icon name={item.icon} size={15} />}
              {item.label}
              {item.count !== undefined && <span className="tabs__count t-num">{item.count}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
