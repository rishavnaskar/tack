import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { applying, isActive } from '../../api/applying';
import type { ApplyBatch, ApplyRun, ApplyStep } from '../../api/types';
import { Button, Icon, ease } from '../../ui';
import './ApplyRuns.css';

const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [on]);
  return now;
}

const STATUS: Record<ApplyRun['status'], string> = { queued: 'Waiting', running: 'Applying', applied: 'Confirmed', failed: 'Not sent', 'dry-run': 'Dry run, not sent' };
const REASON: Record<string, string> = {
  'form-not-found': 'Form not found', 'login-required': 'Sign-in required', captcha: 'CAPTCHA', 'answer-missing': 'Answer needed',
  'consent-needed': 'Consent needed', timeout: 'Timed out', 'site-error': 'Site error',
};

function StepRow({ step, current }: { step: ApplyStep; current: boolean }) {
  const bad = step.kind === 'error';
  const done = step.kind === 'confirm';
  return (
    <li className={['run__step', current && 'is-current', bad && 'is-bad', done && 'is-done'].filter(Boolean).join(' ')}>
      <span className="run__mark" aria-hidden="true">
        {bad ? <Icon name="warning" size={12} /> : current && !done ? <span className="pulse-dot" /> : <Icon name="check" size={12} />}
      </span>
      <span>{step.label}</span>
    </li>
  );
}

export function RunCard({ run, compact }: { run: ApplyRun; compact?: boolean }) {
  const active = isActive(run);
  const now = useNow(active);
  const ms = run.ms ?? (active ? now - Date.parse(run.startedAt) : 0);
  const steps = compact ? run.steps.slice(-4) : run.steps;
  return (
    <motion.article
      className={['run', `is-${run.status}`].join(' ')}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease }}
      aria-live="polite"
    >
      <header className="run__head">
        <div className="run__who">
          <span className="run__company">{run.company}</span>
          <span className="run__title">{run.title}</span>
        </div>
        {run.dryRun ? (
          <span className="run__target t-micro is-dry">DRY RUN</span>
        ) : (
          <span className={`run__target t-micro is-${run.target}`}>{run.target === 'practice' ? 'practice application' : 'live posting'}</span>
        )}
      </header>
      <div className="run__status t-mono">
        <span className={`run__state is-${run.status}`}>{STATUS[run.status]}</span>
        <span className="t-faint">{run.fields ? `${run.fields} fields · ` : ''}{ms ? secs(ms) : ''}</span>
      </div>
      {steps.length > 0 ? (
        <ol className="run__steps">
          {steps.map((s, i) => (
            <StepRow key={`${s.kind}-${i}`} step={s} current={active && i === steps.length - 1} />
          ))}
        </ol>
      ) : (
        <p className="run__wait t-faint">{run.status === 'queued' ? 'Starting the engine and preparing answers' : 'Opening a browser window'}</p>
      )}
      {run.shot && !active && (
        <a className="run__shot" href={`/api/apply/runs/${encodeURIComponent(run.id)}/shot`} target="_blank" rel="noreferrer" title="The engine's page when it finished">
          <img src={`/api/apply/runs/${encodeURIComponent(run.id)}/shot`} alt={`The page at ${run.company} when the engine finished`} loading="lazy" />
        </a>
      )}
      {run.status === 'applied' && run.confirmation && <p className="run__foot is-ok">{run.confirmation}</p>}
      {run.status === 'dry-run' && run.confirmation && <p className="run__foot is-dry">{run.confirmation}</p>}
      {run.status === 'failed' && run.reason && (
        <p className="run__foot is-bad">
          {run.reasonCode && <b>{REASON[run.reasonCode]}. </b>}
          {run.reason}
        </p>
      )}
    </motion.article>
  );
}

export function BatchPanel({ batch }: { batch: ApplyBatch }) {
  const active = batch.runs.some(isActive);
  const now = useNow(active);
  const ok = batch.runs.filter((r) => r.status === 'applied').length;
  const failed = batch.runs.filter((r) => r.status === 'failed').length;
  const dry = batch.runs.filter((r) => r.status === 'dry-run').length;
  const ms = batch.ms ?? now - Date.parse(batch.startedAt);
  const practice = batch.runs.every((r) => r.target === 'practice');
  return (
    <section className="batch" aria-label="Applications in progress">
      <div className="batch__head">
        <p className="batch__line">
          {batch.dryRun && <span className="run__target t-micro is-dry">DRY RUN</span>}
          <span className="t-label">{batch.runs.length === 1 ? 'One application' : `${batch.runs.length} applications in parallel`}</span>
          <span className="t-mono t-faint">
            {active ? `${ok + failed + dry} of ${batch.runs.length} done · ${secs(ms)}` : batch.dryRun ? `${dry} of ${batch.runs.length} filled, none submitted, in ${secs(ms)}` : `${ok} of ${batch.runs.length} submitted in ${secs(ms)}`}
          </span>
        </p>
        {batch.dryRun && <p className="batch__note t-faint">Dry run: every form is filled for real and left unsent. Nothing here is an application.</p>}
        {practice && !batch.dryRun && <p className="batch__note t-faint">Practice applications: each one opens in its own Chrome window and is sent to Tack's practice form, never to the company.</p>}
        {!active && (
          <Button variant="quiet" size="sm" iconLeft="close" onClick={() => applying.dismiss(batch.id)}>
            Dismiss
          </Button>
        )}
      </div>
      <div className="batch__runs" data-count={batch.runs.length}>
        {batch.runs.map((r) => (
          <RunCard key={r.id} run={r} compact={batch.runs.length > 3} />
        ))}
      </div>
    </section>
  );
}
