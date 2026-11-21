import type { PlanTask } from '../../api/types';

type Kind = PlanTask['kind'];

export const kindLabel: Record<Kind, string> = {
  learn: 'Learn',
  practice: 'Practice',
  project: 'Project',
  interview: 'Interview',
  apply: 'Apply',
};

/** One small shape per task kind, so the list reads without colour. */
export function KindGlyph({ kind, size = 10 }: { kind: Kind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true" className="kind-glyph">
      {kind === 'learn' && <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.2" />}
      {kind === 'practice' && (
        <>
          <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M1.4 5a3.6 3.6 0 0 0 7.2 0z" fill="currentColor" />
        </>
      )}
      {kind === 'project' && <rect x="1.6" y="1.6" width="6.8" height="6.8" rx="1" fill="currentColor" />}
      {kind === 'interview' && <path d="M5 1.2 8.8 5 5 8.8 1.2 5z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />}
      {kind === 'apply' && <path d="M2.2 7.8 7.6 2.4M3.6 2.2h4.2v4.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

export function KindMark({ kind }: { kind: Kind }) {
  return (
    <span className="kind-mark">
      <KindGlyph kind={kind} />
      {kindLabel[kind]}
    </span>
  );
}
