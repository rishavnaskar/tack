import type { ReactNode } from 'react';
import './QuoteBlock.css';

export interface QuoteBlockProps {
  quote: string;
  /** Where the quote comes from: "Résumé", a company name, a posting title. */
  source: ReactNode;
  /** Secondary source text, e.g. a host name or role. */
  detail?: ReactNode;
  tone?: 'paper' | 'accent' | 'olive';
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
}

export function QuoteBlock({ quote, source, detail, tone = 'paper', size = 'md', onClick }: QuoteBlockProps) {
  const cls = ['quote', `quote--${tone}`, `quote--${size}`, onClick && 'quote--button'].filter(Boolean).join(' ');
  const body = (
    <>
      <p className="quote__text">
        <span className="quote__mark" aria-hidden="true">
          &ldquo;
        </span>
        {quote}
        <span aria-hidden="true">&rdquo;</span>
      </p>
      <span className="quote__source">
        <span className="t-label quote__name">{source}</span>
        {detail && <span className="t-micro">{detail}</span>}
      </span>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick}>
        {body}
      </button>
    );
  }
  return <blockquote className={cls}>{body}</blockquote>;
}
