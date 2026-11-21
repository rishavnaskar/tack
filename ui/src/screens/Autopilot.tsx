import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { api } from '../api/client';
import { invalidate, useQuery } from '../api/query';
import { keys } from '../api/hooks';
import { useTrace } from '../api/events';
import type { ApplyJob, ApplyRun, AutopilotRunBrief, AutopilotRunFull, AutopilotSettings, AutopilotStatus, RunStepView } from '../api/types';
import { pad2 } from '../lib/format';
import { Button, Card, EmptyState, ErrorState, Icon, PageHeader, Skeleton, Stepper, TextArea, TextField, Toggle, ease, useToast } from '../ui';
import { SectionHead } from './tracker/Pipeline';
import { RunCard } from './tracker/ApplyRuns';
import './Autopilot.css';

export const REASON_LABEL: Record<string, string> = {
  'form-not-found': 'Form not found', 'login-required': 'Sign-in required', captcha: 'CAPTCHA', 'answer-missing': 'Answer needed',
  'consent-needed': 'Consent needed', timeout: 'Timed out', 'site-error': 'Site error',
};

const STATE_LABEL: Record<string, string> = {
  submitted: 'Submitted', 'dry-run': 'Dry run, not sent', 'needs-you': 'Needs you', 'awaiting-approval': 'Waiting for your yes', queued: 'Queued',
  running: 'Applying', failed: 'Not sent', skipped: 'Skipped', 'not started': 'Not started',
};

const RUN_LABEL: Record<AutopilotRunBrief['status'], string> = { running: 'Running', done: 'Done', partial: 'Done with problems', failed: 'Failed', interrupted: 'Interrupted' };

const secs = (ms?: number) => (ms == null ? '' : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

function when(at?: string | null) {
  if (!at) return '';
  const d = new Date(at);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return same ? `today at ${time}` : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${time}`;
}

export function useAutopilot() {
  const q = useQuery<AutopilotStatus>('autopilot', api.autopilot);
  const busy = !!q.data?.running || !!q.data?.applying;
  useEffect(() => {
    const t = window.setInterval(() => q.refetch().catch(() => undefined), busy ? 2500 : 30_000);
    return () => window.clearInterval(t);
  }, [busy]);
  return q;
}

export function Autopilot() {
  const ap = useAutopilot();
  const s = ap.data;

  return (
    <div className="ap">
      <PageHeader
        index="08"
        section="Autopilot"
        title="It runs while you get on with things"
        purpose="Every few hours Tack reads the market, rebuilds the gap, picks the best postings, applies to them in parallel, reads the replies and replans. Nothing waits on a click."
      />
      {ap.error && !s ? (
        <ErrorState title="Could not load the autopilot" message={ap.error.message} onRetry={() => ap.refetch().catch(() => undefined)} />
      ) : !s ? (
        <div className="ap__skel" aria-busy="true">
          <Skeleton height={180} radius={16} />
          <Skeleton height={320} radius={16} />
        </div>
      ) : (
        <>
          {s.dryRun && (
            <div className="ap__dry" role="alert">
              <span className="ap__dry-tag t-mono">DRY RUN</span>
              <span>Forms are filled for real and never submitted. Nothing in this mode is an application, and none is recorded as one.</span>
            </div>
          )}
          {!s.readiness.ready && <Missing s={s} />}
          <StatusCard s={s} onChange={() => ap.refetch()} />
          {s.running && <LiveRun run={s.running} />}
          <NeedsYou s={s} onChange={() => ap.refetch()} />
          <Settings s={s} onSaved={() => ap.refetch()} />
          <History s={s} />
          {s.remembered.length > 0 && <Remembered s={s} onChange={() => ap.refetch()} />}
        </>
      )}
    </div>
  );
}

function Missing({ s }: { s: AutopilotStatus }) {
  return (
    <Card pad="lg" className="ap__missing" settle>
      <p className="ap__missing-head">
        <Icon name="warning" size={18} /> Before the autopilot can run, Tack needs:
      </p>
      <ul>
        {s.readiness.missing.map((m) => (
          <li key={m.key}>
            <span className="t-paper">{m.label}</span> <span className="t-faint">· {m.where}</span>
          </li>
        ))}
      </ul>
      <Button variant="primary" icon="arrow-right" to="/">
        Go to Start
      </Button>
    </Card>
  );
}

function StatusCard({ s, onChange }: { s: AutopilotStatus; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'toggle' | 'run'>();
  const set = s.settings;
  const cap = set.dailyCap;

  const toggle = async (on: boolean) => {
    setBusy('toggle');
    try {
      await api.saveAutopilot({ on });
      onChange();
      toast(on ? { title: 'Autopilot is on', body: 'The first run starts in a couple of minutes, then every few hours by itself.', tone: 'success' } : { title: 'Autopilot is off' });
    } catch (e) {
      toast({ title: 'Could not switch it', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(undefined);
    }
  };

  const runNow = async () => {
    setBusy('run');
    try {
      await api.runAutopilot();
      onChange();
      toast({ title: 'Running now', body: 'Follow it below; the trace on the right shows every step.' });
    } catch (e) {
      toast({ title: 'Could not start a run', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(undefined);
    }
  };

  const line = s.running
    ? `Running now: ${s.running.steps.find((x) => x.status === 'running')?.label ?? 'starting'}`
    : !set.on ? 'Off. Switch it on and it runs by itself.'
      : s.nextRunAt ? `Next run ${when(s.nextRunAt)}${set.quietHours ? `, never between ${set.quietHours.from} and ${set.quietHours.to}` : ''}` : 'Waiting';

  return (
    <Card pad="lg" className={['ap__status', set.on && 'is-on', s.running && 'is-running'].filter(Boolean).join(' ')} settle>
      <div className="ap__status-top">
        <Toggle
          checked={set.on}
          onChange={toggle}
          disabled={busy === 'toggle' || (!set.on && !s.readiness.ready)}
          label={set.on ? 'Autopilot on' : 'Autopilot off'}
          hint={`Every ${set.intervalHours} h · up to ${cap} a day · fit ${set.minFit} and up${set.needsApproval ? ' · each one waits for your yes' : ''}`}
        />
        <Button variant="primary" icon="arrow-right" onClick={runNow} loading={busy === 'run'} disabled={!!s.running || s.applying || !s.readiness.ready}>
          Run now
        </Button>
      </div>
      <p className="ap__line" aria-live="polite">
        {s.running && <span className="pulse-dot" />} {line}
      </p>
      <dl className="ap__figs">
        <div>
          <dt className="t-label">Sent today</dt>
          <dd className="t-num">
            {s.queue.today}
            <span className="t-faint"> / {cap}</span>
          </dd>
        </div>
        <div>
          <dt className="t-label">Submitted</dt>
          <dd className="t-num">{s.queue.submitted}</dd>
        </div>
        <div>
          <dt className="t-label">Needs you</dt>
          <dd className={['t-num', s.needsYou.length && 'is-hot'].filter(Boolean).join(' ')}>{s.needsYou.length}</dd>
        </div>
        <div>
          <dt className="t-label">Retrying</dt>
          <dd className="t-num">{s.queue.queued}</dd>
        </div>
        <div>
          <dt className="t-label">Replies checked</dt>
          <dd className="ap__fig-text">{s.mail.last ? when(s.mail.last.at) : 'not yet'}</dd>
        </div>
      </dl>
      {s.readiness.warnings.map((w) => (
        <p key={w} className="ap__warn">
          <Icon name="warning" size={14} /> {w}
        </p>
      ))}
      {s.lastRun?.summary && !s.running && (
        <p className="ap__last">
          <span className="t-label">Last run · {when(s.lastRun.startedAt)}</span>
          {s.lastRun.summary}
        </p>
      )}
    </Card>
  );
}

function StepList({ steps, live }: { steps: RunStepView[]; live?: boolean }) {
  return (
    <ol className="ap__steps">
      {steps.map((st, i) => (
        <li key={st.name} className={`ap__step is-${st.status}`}>
          <span className="ap__step-mark" aria-hidden="true">
            {st.status === 'running' && live ? <span className="pulse-dot" /> : st.status === 'failed' ? <Icon name="warning" size={12} /> : st.status === 'done' ? <Icon name="check" size={12} /> : st.status === 'skipped' ? <Icon name="minus" size={12} /> : pad2(i + 1)}
          </span>
          <span className="ap__step-label">{st.label}</span>
          <span className="ap__step-ms t-mono t-faint">{secs(st.ms)}</span>
          {st.note && <span className="ap__step-note">{st.note}</span>}
        </li>
      ))}
    </ol>
  );
}

function LiveRun({ run }: { run: AutopilotRunBrief }) {
  const { events } = useTrace();
  const runs = useQuery<ApplyRun[]>('apply-runs', api.applyRuns);
  useEffect(() => {
    const t = window.setInterval(() => runs.refetch().catch(() => undefined), 2000);
    return () => window.clearInterval(t);
  }, []);
  const mine = (runs.data ?? []).filter((r) => r.startedAt >= run.startedAt);
  const lines = events.filter((e) => e.at >= run.startedAt && (e.run === 'autopilot' || e.run.startsWith('apply') || e.run === 'model' || e.run === 'gap' || e.run === 'harvest')).slice(-14);
  return (
    <section className="section">
      <SectionHead index="01" title="Running now" text={`Started ${when(run.startedAt)}${run.resumes ? `, resumed ${run.resumes} time${run.resumes === 1 ? '' : 's'} after a restart` : ''}.`} />
      <div className="ap__live">
        <Card pad="md" label="Steps" className="ap__live-steps">
          <StepList steps={run.steps} live />
        </Card>
        <Card pad="md" label="Trace" className="ap__live-trace">
          <ol className="ap__trace t-mono">
            {lines.map((e) => (
              <motion.li key={e.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, ease }} className={`is-${e.status}`}>
                <span className="t-faint">{e.run}</span> {e.step}
                {e.detail ? `: ${e.detail}` : ''}
              </motion.li>
            ))}
            {!lines.length && <li className="t-faint">Waiting for the first step</li>}
          </ol>
        </Card>
      </div>
      {mine.length > 0 && (
        <div className="batch__runs ap__runs" data-count={mine.length}>
          {mine.map((r) => <RunCard key={r.id} run={r} compact={mine.length > 3} />)}
        </div>
      )}
    </section>
  );
}

function JobRow({ j, onChange }: { j: ApplyJob; onChange: () => void }) {
  const toast = useToast();
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<string>();
  const act = async (what: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(what);
    try {
      await fn();
      onChange();
      invalidate(keys.applications, keys.insights);
      toast({ title: done, tone: 'success' });
    } catch (e) {
      toast({ title: 'That did not work', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(undefined);
    }
  };
  const approval = j.state === 'awaiting-approval';
  const asks = !approval && j.reason === 'answer-missing' && j.question;
  return (
    <li className="ap__job">
      <div className="ap__job-head">
        <span className="ap__job-who">
          <b>{j.company}</b> · {j.title}
        </span>
        <span className={`ap__reason t-micro is-${approval ? 'approval' : j.reason ?? 'other'}`}>{approval ? 'Waiting for your yes' : REASON_LABEL[j.reason ?? ''] ?? 'Needs you'}</span>
      </div>
      {approval ? (
        <p className="ap__job-detail">{j.why ?? `Fit ${j.fit ?? ''}`}</p>
      ) : (
        <p className="ap__job-detail">{j.detail}</p>
      )}
      {asks && (
        <form
          className="ap__answer"
          onSubmit={(e) => {
            e.preventDefault();
            if (answer.trim()) void act('answer', () => api.answerJob(j.id, answer), 'Answered. It is remembered and the form goes again.');
          }}
        >
          <TextField label={j.question} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer, once" />
          <Button variant="primary" size="sm" type="submit" loading={busy === 'answer'} disabled={!answer.trim()}>
            Answer and retry
          </Button>
        </form>
      )}
      <div className="ap__job-acts">
        {approval ? (
          <Button variant="primary" size="sm" icon="arrow-right" onClick={() => act('approve', () => api.approveJob(j.id), 'Approved. Applying now.')} loading={busy === 'approve'}>
            Apply
          </Button>
        ) : (
          !asks && (
            <Button variant="ghost" size="sm" iconLeft="refresh" onClick={() => act('retry', () => api.retryJob(j.id), 'Back in the queue.')} loading={busy === 'retry'}>
              {j.reason === 'captcha' || j.reason === 'login-required' ? 'I have done it, retry' : 'Retry'}
            </Button>
          )
        )}
        <Button variant="quiet" size="sm" onClick={() => act('skip', () => api.skipJob(j.id), 'Skipped.')} loading={busy === 'skip'}>
          Skip
        </Button>
        {j.url && (
          <a className="ap__open" href={j.url} target="_blank" rel="noreferrer">
            Open the posting <Icon name="arrow-up-right" size={13} />
          </a>
        )}
      </div>
    </li>
  );
}

function NeedsYou({ s, onChange }: { s: AutopilotStatus; onChange: () => void }) {
  if (!s.needsYou.length) return null;
  return (
    <section className="section">
      <SectionHead index="02" title="Needs you" text="What only you can settle. Answer a question once and every later form reuses it; Tack never solves a CAPTCHA, signs in or creates an account for you." />
      <ul className="ap__jobs">
        {s.needsYou.map((j) => <JobRow key={j.id} j={j} onChange={onChange} />)}
      </ul>
    </section>
  );
}

function Settings({ s, onSaved }: { s: AutopilotStatus; onSaved: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<AutopilotSettings>(s.settings);
  const [roles, setRoles] = useState(s.settings.excludeRoles.join('\n'));
  const [companies, setCompanies] = useState(s.settings.excludeCompanies.join('\n'));
  const [quiet, setQuiet] = useState(s.settings.quietHours ?? { from: '', to: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    setD(s.settings);
    setRoles(s.settings.excludeRoles.join('\n'));
    setCompanies(s.settings.excludeCompanies.join('\n'));
    setQuiet(s.settings.quietHours ?? { from: '', to: '' });
  }, [s.settings.intervalHours, s.settings.dailyCap, s.settings.minFit, s.settings.needsApproval, s.settings.mailEveryHours, s.settings.excludeRoles.join('|'), s.settings.excludeCompanies.join('|'), s.settings.quietHours?.from, s.settings.quietHours?.to]);
  const dirty = d.intervalHours !== s.settings.intervalHours || d.dailyCap !== s.settings.dailyCap || d.minFit !== s.settings.minFit || d.needsApproval !== s.settings.needsApproval
    || d.mailEveryHours !== s.settings.mailEveryHours || roles !== s.settings.excludeRoles.join('\n') || companies !== s.settings.excludeCompanies.join('\n')
    || (quiet.from || '') !== (s.settings.quietHours?.from ?? '') || (quiet.to || '') !== (s.settings.quietHours?.to ?? '');

  const save = async () => {
    setSaving(true);
    setErr(undefined);
    try {
      await api.saveAutopilot({
        intervalHours: d.intervalHours, dailyCap: d.dailyCap, minFit: d.minFit, needsApproval: d.needsApproval, mailEveryHours: d.mailEveryHours,
        excludeRoles: roles.split('\n'), excludeCompanies: companies.split('\n'),
        quietHours: quiet.from || quiet.to ? quiet : null,
      });
      onSaved();
      toast({ title: 'Settings saved', tone: 'success' });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="section">
      <SectionHead index="03" title="Settings" text="How often, how many and which. Exclusions are never applied to, whatever their fit." />
      <Card pad="lg" className="ap__settings">
        <div className="ap__grid">
          <Stepper label="Run every" unit="hours" value={d.intervalHours} min={1} max={168} onChange={(v) => setD({ ...d, intervalHours: v })} />
          <Stepper label="Daily cap" unit="a day" value={d.dailyCap} min={1} max={15} onChange={(v) => setD({ ...d, dailyCap: v })} hint="At most 15." />
          <Stepper label="Minimum fit" value={d.minFit} min={0} max={100} step={5} onChange={(v) => setD({ ...d, minFit: v })} />
          <Stepper label="Read replies every" unit="hours" value={d.mailEveryHours} min={0} max={168} onChange={(v) => setD({ ...d, mailEveryHours: v })} hint="0 reads them only during runs." />
        </div>
        <div className="ap__grid ap__grid--2">
          <TextArea label="Never apply to these roles" hint="One per line; a title containing any of them is left out." value={roles} onChange={(e) => setRoles(e.target.value)} rows={3} />
          <TextArea label="Never apply to these companies" hint="One per line." value={companies} onChange={(e) => setCompanies(e.target.value)} rows={3} />
        </div>
        <div className="ap__quiet">
          <TextField label="Quiet hours from" type="time" value={quiet.from} onChange={(e) => setQuiet({ ...quiet, from: e.target.value })} />
          <TextField label="to" type="time" value={quiet.to} onChange={(e) => setQuiet({ ...quiet, to: e.target.value })} />
          {(quiet.from || quiet.to) && (
            <Button variant="quiet" size="sm" onClick={() => setQuiet({ from: '', to: '' })}>
              No quiet hours
            </Button>
          )}
        </div>
        <Toggle
          checked={d.needsApproval}
          onChange={(v) => setD({ ...d, needsApproval: v })}
          label="Applications need my approval"
          hint={d.needsApproval ? 'Each pick waits under Needs you until you press Apply.' : 'Off: fully automated. Picks are applied to as soon as they are chosen.'}
        />
        {err && (
          <p className="ap__err" role="alert">
            <Icon name="warning" size={14} /> {err}
          </p>
        )}
        <div className="ap__save">
          <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>
            Save settings
          </Button>
        </div>
      </Card>
    </section>
  );
}

function History({ s }: { s: AutopilotStatus }) {
  const [open, setOpen] = useState<string>();
  const past = s.runs.filter((r) => r.id !== s.running?.id);
  return (
    <section className="section">
      <SectionHead index="04" title="Run history" text="Every run, with what it read, what changed in the market, what it applied to and why, what came back and what the plan changed." />
      {!past.length ? (
        <EmptyState compact eyebrow="No runs yet" title="Nothing has run yet" body={s.readiness.ready ? 'Press Run now, or switch the autopilot on and the first run starts by itself.' : 'Fill in what is missing above, then run it.'} />
      ) : (
        <ol className="ap__history">
          {past.map((r) => (
            <li key={r.id} className={`ap__run is-${r.status}`}>
              <button type="button" className="ap__run-head" onClick={() => setOpen(open === r.id ? undefined : r.id)} aria-expanded={open === r.id}>
                <span className="ap__run-when">{when(r.startedAt)}</span>
                <span className={`ap__run-status t-micro is-${r.status}`}>{RUN_LABEL[r.status]}</span>
                {r.dryRun && <span className="ap__dry-tag t-mono">DRY RUN</span>}
                <span className="ap__run-trigger t-faint">{r.trigger === 'manual' ? 'Run now' : 'scheduled'}{r.resumes ? ', resumed' : ''} · {secs(r.ms)}</span>
                <span className="ap__run-sum">{r.summary ?? r.steps.filter((x) => x.status === 'failed').map((x) => `${x.label}: ${x.note}`).join(' ')}</span>
                <Icon name={open === r.id ? 'chevron-up' : 'chevron-down'} size={16} />
              </button>
              {open === r.id && <RunReport id={r.id} />}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function RunReport({ id }: { id: string }) {
  const q = useQuery<AutopilotRunFull>(`autopilot-run:${id}`, () => api.autopilotRun(id));
  const r = q.data;
  const rep = r?.report;
  const changes = useMemo(() => rep?.replies?.changes ?? [], [rep]);
  if (q.error) return <ErrorState compact title="Could not load the report" message={q.error.message} />;
  if (!r) return <Skeleton height={160} radius={12} />;
  return (
    <motion.div className="ap__report" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }}>
      {rep?.summary && <p className="ap__report-sum">{rep.summary}</p>}
      <div className="ap__report-grid">
        <div>
          <h4 className="t-label">Read</h4>
          <p>{rep?.read.note || 'Nothing read.'}</p>
          {rep && rep.read.fresh.length > 0 && <p className="t-faint">New: {rep.read.fresh.slice(0, 8).map((p) => p.company).join(', ')}{rep.read.fresh.length > 8 ? ` and ${rep.read.fresh.length - 8} more` : ''}</p>}
          {rep && rep.read.closed.length > 0 && <p className="t-faint">Closed: {rep.read.closed.map((p) => `${p.title} at ${p.company}`).join(', ')}</p>}
          {rep?.readiness.after != null && <p>Readiness {rep.readiness.before != null && rep.readiness.before !== rep.readiness.after ? `${rep.readiness.before} to ${rep.readiness.after}` : rep.readiness.after}</p>}
        </div>
        <div>
          <h4 className="t-label">Replies</h4>
          <p>{rep?.replies ? rep.replies.note : 'Mail was not read in this run.'}</p>
          {changes.map((c) => (
            <p key={`${c.company}-${c.subject}`} className="t-faint">
              {c.company}: {c.from} to {c.to} · {c.subject}
            </p>
          ))}
        </div>
        <div>
          <h4 className="t-label">Plan</h4>
          <p>{rep?.plan ? (rep.plan.changed ? rep.plan.summary : 'On track; unchanged.') : 'No plan yet.'}</p>
        </div>
      </div>
      {rep && rep.applied.length > 0 && (
        <>
          <h4 className="t-label">Applied to, and why</h4>
          <ul className="ap__applied">
            {rep.applied.map((a) => (
              <li key={`${a.company}-${a.title}`}>
                <span className="ap__applied-who">
                  <b>{a.company}</b> · {a.title} <span className="t-faint">fit {a.fit}</span>
                </span>
                <span className={`ap__state t-micro is-${a.state}`}>{STATE_LABEL[a.state] ?? a.state}</span>
                <span className="ap__applied-why t-faint">{a.why}{a.detail ? ` · ${a.detail}` : ''}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {rep && rep.problems.length > 0 && (
        <p className="ap__err">
          <Icon name="warning" size={14} /> {rep.problems.join(' · ')}
        </p>
      )}
      <h4 className="t-label">Steps</h4>
      <StepList steps={r.steps} />
    </motion.div>
  );
}

function Remembered({ s, onChange }: { s: AutopilotStatus; onChange: () => void }) {
  return (
    <section className="section">
      <SectionHead index="05" title="Answers you gave" text="Reused on every later form that asks the same thing." />
      <ul className="ap__remembered">
        {s.remembered.map((a) => (
          <li key={a.id}>
            <span className="t-faint">{a.question}</span>
            <span className="t-paper">{a.answer}</span>
            <Button variant="quiet" size="sm" onClick={() => api.forgetAnswer(a.id).then(onChange)}>
              Forget
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The compact block on Progress. */
export function AutopilotBlock() {
  const ap = useAutopilot();
  const s = ap.data;
  if (!s) return null;
  const on = s.settings.on;
  return (
    <Card pad="md" className="ap-block" label="Autopilot" index="00" aside={<Button variant="quiet" size="sm" icon="arrow-right" to="/autopilot">Open</Button>} settle>
      <div className="ap-block__row">
        <span className={['ap-block__dot', on && 'is-on', s.running && 'is-running'].filter(Boolean).join(' ')} aria-hidden="true" />
        <span className="ap-block__state">
          {s.running ? `Running: ${s.running.steps.find((x) => x.status === 'running')?.label ?? 'starting'}` : on ? `On · next run ${when(s.nextRunAt)}` : 'Off'}
        </span>
        <span className="ap-block__figs t-mono">
          {s.queue.today}/{s.settings.dailyCap} today · {s.queue.submitted} sent{s.needsYou.length ? ` · ${s.needsYou.length} need you` : ''}
        </span>
      </div>
      {s.dryRun && <p className="ap-block__line"><span className="ap__dry-tag t-mono">DRY RUN</span> nothing is submitted</p>}
      {s.lastRun?.summary && <p className="ap-block__line">{s.lastRun.summary}</p>}
      {!s.readiness.ready && <p className="ap-block__line t-faint">Needs: {s.readiness.missing.map((m) => m.label.toLowerCase()).join('; ')}.</p>}
    </Card>
  );
}
