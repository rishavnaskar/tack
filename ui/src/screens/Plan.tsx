import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '../api/client';
import { useLatestTrace } from '../api/events';
import { actions, keys, useAppState, useGap, usePlan, useProgress } from '../api/hooks';
import { fetchQuery, getQueryData, invalidate, setQueryData } from '../api/query';
import type { GapMap, Plan as PlanData, PlanChange, PlanTask, PlanWeek, Progress } from '../api/types';
import { pad2, shortDate } from '../lib/format';
import {
  BlueprintLoader,
  Button,
  Card,
  Chip,
  Drawer,
  EmptyState,
  ErrorState,
  Icon,
  Meter,
  Modal,
  PageHeader,
  Skeleton,
  Stat,
  TextField,
  ease,
  useNarrow,
  useToast,
} from '../ui';
import { KindGlyph, KindMark, kindLabel } from './plan/KindMark';
import {
  addDays,
  changesNewestFirst,
  currentWeek,
  dayLabel,
  hrs,
  localToday,
  readMove,
  round1,
  skillNamer,
  versionOf,
  weekLoad,
  weekOfToday,
  weekSpan,
  withCheckpoint,
  withTaskStatus,
} from './plan/weeks';
import './Plan.css';

type Phase = 'past' | 'current' | 'next';
type TaskStatus = PlanTask['status'];

const REASONS = ['Fell behind this week', 'A busy week ahead', 'Moving faster than planned'];

function readinessNow(): number | undefined {
  const r = getQueryData<Progress>(keys.progress)?.readiness;
  if (r?.length) return r[r.length - 1].value;
  return getQueryData<GapMap | null>(keys.gap)?.readiness;
}

export function Plan() {
  const plan = usePlan();
  const gap = useGap();
  const progress = useProgress();
  const { data: state } = useAppState();
  const narrow = useNarrow();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [building, setBuilding] = useState(false);
  const [since, setSince] = useState(0);
  const [askReplan, setAskReplan] = useState(false);
  const [replanning, setReplanning] = useState(false);
  const [freshAt, setFreshAt] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [calBusy, setCalBusy] = useState(false);

  const data = plan.data;
  const budget = state?.goal?.hoursPerWeek ?? 10;
  const name = useMemo(() => skillNamer(gap.data), [gap.data]);
  const today = localToday();
  const raw = data ? weekOfToday(data, today) : 0;
  const cur = data ? currentWeek(data, today) : 1;
  const newest = data ? changesNewestFirst(data)[0] : undefined;
  const fresh = newest && newest.at === freshAt ? newest : undefined;

  // the brief links here with ?replan=1
  useEffect(() => {
    if (!params.get('replan') || !data) return;
    setAskReplan(true);
    const next = new URLSearchParams(params);
    next.delete('replan');
    setParams(next, { replace: true });
  }, [params, data, setParams]);

  const announce = (before: number | undefined, after: number | undefined, body?: string) => {
    if (before === undefined || after === undefined) return;
    const a = Math.round(before);
    const b = Math.round(after);
    if (a !== b) toast({ title: `Readiness ${a} to ${b}`, body, tone: b > a ? 'success' : 'default' });
  };

  const setTask = async (task: PlanTask, status: TaskStatus) => {
    const was = task.status;
    const before = readinessNow();
    setQueryData<PlanData | null>(keys.plan, (p) => (p ? withTaskStatus(p, task.id, status) : p ?? null));
    try {
      await actions.setTaskStatus(task.id, status);
      invalidate(keys.gap);
      announce(before, readinessNow(), status === 'done' ? task.title : undefined);
    } catch (e) {
      setQueryData<PlanData | null>(keys.plan, (p) => (p ? withTaskStatus(p, task.id, was) : p ?? null));
      toast({ title: 'Could not update the task', body: (e as Error).message, tone: 'error' });
    }
  };

  const setCheckpoint = async (week: PlanWeek, passed: boolean) => {
    if (week.checkpoint.passed === passed) return;
    const was = week.checkpoint.passed;
    const before = readinessNow();
    setQueryData<PlanData | null>(keys.plan, (p) => (p ? withCheckpoint(p, week.index, passed) : p ?? null));
    try {
      await actions.checkpoint(week.index, passed);
      invalidate(keys.gap);
      const p = await fetchQuery<Progress>(keys.progress).catch(() => undefined);
      const after = p?.readiness.length ? p.readiness[p.readiness.length - 1].value : undefined;
      if (before !== undefined && after !== undefined && Math.round(before) !== Math.round(after)) {
        announce(before, after, `Week ${week.index} checkpoint ${passed ? 'passed' : 'not yet passed'}.`);
      } else if (!passed) {
        toast({ title: `Week ${week.index} checkpoint not yet passed`, body: 'The next replan adds a repair block for it.' });
      }
    } catch (e) {
      setQueryData<PlanData | null>(keys.plan, (p) =>
        p ? { ...p, weeks: p.weeks.map((w) => (w.index === week.index ? { ...w, checkpoint: { ...w.checkpoint, passed: was } } : w)) } : p ?? null,
      );
      toast({ title: 'Could not save the checkpoint', body: (e as Error).message, tone: 'error' });
    }
  };

  const replan = async (reason?: string) => {
    setAskReplan(false);
    setReplanning(true);
    try {
      const next = await actions.replan(reason);
      invalidate(keys.gap);
      setFreshAt(changesNewestFirst(next)[0]?.at);
    } catch (e) {
      toast({ title: 'Could not replan', body: (e as Error).message, tone: 'error' });
    } finally {
      setReplanning(false);
    }
  };

  const build = async () => {
    setSince(Date.now());
    setBuilding(true);
    try {
      const p = await actions.buildPlan();
      invalidate(keys.gap);
      const tasks = p.weeks.reduce((a, w) => a + w.tasks.length, 0);
      toast({ title: 'Plan ready', body: `${p.weeks.length} weeks and ${tasks} tasks inside ${budget} hours a week.`, tone: 'success' });
    } catch (e) {
      toast({ title: 'Could not build the plan', body: (e as Error).message, tone: 'error' });
    } finally {
      setBuilding(false);
    }
  };

  const calendar = async () => {
    setCalBusy(true);
    try {
      const ics = await api.calendar();
      const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tack-plan.ics';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast({ title: 'Calendar file saved', body: 'Open tack-plan.ics to add each week and its checkpoint to your calendar.', tone: 'success' });
    } catch (e) {
      toast({ title: 'Could not export the calendar', body: (e as Error).message, tone: 'error' });
    } finally {
      setCalBusy(false);
    }
  };

  return (
    <div className="plan">
      <PageHeader
        index="03"
        section="Plan"
        title="The move, week by week"
        purpose={`Tasks sized to your ${budget} hours a week, a checkpoint at the end of each week, and a replan when a week slips.`}
        actions={
          data && !building ? (
            <>
              <Button variant="quiet" iconLeft="list" onClick={() => setHistoryOpen(true)}>
                History <span className="t-num plan__v">v{data.version}</span>
              </Button>
              <Button variant="quiet" iconLeft="plus" onClick={calendar} loading={calBusy}>
                Add to calendar
              </Button>
              <Button variant="ghost" iconLeft="refresh" onClick={() => setAskReplan(true)} loading={replanning}>
                Replan
              </Button>
            </>
          ) : undefined
        }
      />

      {building ? (
        <Card pad="lg">
          <BuildLoader since={since} />
        </Card>
      ) : plan.error && data === undefined ? (
        <ErrorState title="Could not load the plan" message={plan.error.message} onRetry={() => plan.refetch().catch(() => undefined)} />
      ) : plan.loading ? (
        <PlanSkeleton />
      ) : !data ? (
        <EmptyPlan hasGap={!!gap.data} openSkills={gap.data?.skills.filter((s) => s.level !== 'strong' && s.status !== 'closed').length} budget={budget} weeks={state?.goal?.weeks ?? 12} onBuild={build} />
      ) : (
        <>
          <Overview plan={data} raw={raw} cur={cur} progress={progress.data} />

          <AnimatePresence initial={false}>
            {fresh && (
              <DiffCard key={fresh.at} plan={data} change={fresh} onClose={() => setFreshAt(undefined)} onHistory={() => setHistoryOpen(true)} />
            )}
          </AnimatePresence>

          <Weeks plan={data} raw={raw} budget={budget} name={name} narrow={narrow} onTask={setTask} onCheckpoint={setCheckpoint} />
        </>
      )}

      <ReplanModal open={askReplan} onClose={() => setAskReplan(false)} onReplan={replan} budget={budget} />
      {data && <HistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} plan={data} />}
    </div>
  );
}

/* overview strip */

function Overview({ plan, raw, cur, progress }: { plan: PlanData; raw: number; cur: number; progress?: Progress }) {
  const W = plan.weeks.length;
  const first = plan.weeks[0]?.startDate;
  const end = plan.weeks.length ? addDays(plan.weeks[W - 1].startDate, 6) : undefined;
  const totals = plan.weeks.reduce(
    (a, w) => {
      const l = weekLoad(w);
      return { planned: a.planned + l.planned, done: a.done + l.done };
    },
    { planned: 0, done: 0 },
  );
  const left = raw === 0 ? W : raw > W ? 0 : W - cur + 1;
  const next = plan.weeks.find((w) => w.index >= (raw || 1) && w.checkpoint.passed === undefined);
  const failed = plan.weeks.filter((w) => w.checkpoint.passed === false).length;

  return (
    <Card pad="md" className="plan-over" settle>
      <div className="plan-over__cell">
        <Stat
          label="Weeks left"
          value={left}
          unit={`of ${W}`}
          note={raw === 0 && first ? `Starts ${dayLabel(first)}` : raw > W ? 'The plan has run its course' : `Week ${pad2(cur)} now${end ? `, ends ${dayLabel(end)}` : ''}`}
        />
      </div>
      <div className="plan-over__cell">
        <Stat label="Hours done" value={round1(totals.done)} unit={`of ${round1(totals.planned)} h`} />
        <Meter value={totals.done} max={totals.planned || 1} size="xs" aria-label="Hours done of planned" />
      </div>
      <div className="plan-over__cell">
        <Stat
          label="Pace"
          value={
            progress ? (
              <span className={['plan-over__word', !progress.onTrack && 't-accent'].filter(Boolean).join(' ')}>{progress.onTrack ? 'On track' : 'Behind'}</span>
            ) : (
              <Skeleton width={96} height={22} />
            )
          }
          note={progress?.note}
        />
      </div>
      <div className="plan-over__cell">
        <Stat
          label="Next checkpoint"
          value={<span className="plan-over__word">{next ? `Week ${pad2(next.index)}` : 'None left'}</span>}
          note={
            next
              ? `${next.checkpoint.title}, due ${dayLabel(addDays(next.startDate, 6))}`
              : failed
                ? `${failed} not yet passed. A replan adds repair blocks.`
                : 'Every checkpoint is marked.'
          }
        />
      </div>
    </Card>
  );
}

/* the run of weeks */

function Weeks({
  plan,
  raw,
  budget,
  name,
  narrow,
  onTask,
  onCheckpoint,
}: {
  plan: PlanData;
  raw: number;
  budget: number;
  name: (id: string) => string;
  narrow: boolean;
  onTask: (t: PlanTask, s: TaskStatus) => void;
  onCheckpoint: (w: PlanWeek, passed: boolean) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const [edges, setEdges] = useState({ left: false, right: false });
  const W = plan.weeks.length;
  const phase = (w: PlanWeek): Phase => (raw > W || w.index < raw ? 'past' : w.index === raw ? 'current' : 'next');
  const anchor = raw === 0 ? 1 : raw > W ? W : raw;

  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (narrow || !el || placed.current) return;
    const col = el.querySelector<HTMLElement>(`[data-week="${anchor}"]`);
    if (col) el.scrollLeft = Math.max(0, col.offsetLeft - 56);
    placed.current = true;
    measure();
  }, [narrow, anchor]);

  useEffect(() => {
    if (narrow) return;
    const on = () => measure();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [narrow]);

  const step = (dir: 1 | -1) => {
    const el = scroller.current;
    const col = el?.querySelector<HTMLElement>('.week');
    if (!el || !col) return;
    el.scrollBy({ left: dir * (col.offsetWidth + 14), behavior: 'smooth' });
  };

  const toAnchor = () => {
    const el = scroller.current;
    const col = el?.querySelector<HTMLElement>(`[data-week="${anchor}"]`);
    if (el && col) el.scrollTo({ left: Math.max(0, col.offsetLeft - 56), behavior: 'smooth' });
  };

  const legend = (
    <div className="plan-legend" aria-label="Task kinds">
      {(Object.keys(kindLabel) as PlanTask['kind'][]).map((k) => (
        <span key={k} className="plan-legend__item">
          <KindGlyph kind={k} size={11} />
          {kindLabel[k]}
        </span>
      ))}
    </div>
  );

  const column = (w: PlanWeek, i: number, collapsible = false) => (
    <WeekColumn
      key={w.index}
      week={w}
      phase={phase(w)}
      budget={budget}
      name={name}
      order={i}
      collapsible={collapsible}
      onTask={onTask}
      onCheckpoint={onCheckpoint}
    />
  );

  if (narrow) {
    const current = plan.weeks.filter((w) => phase(w) === 'current');
    const upcoming = plan.weeks.filter((w) => phase(w) === 'next');
    const past = plan.weeks.filter((w) => phase(w) === 'past').reverse();
    return (
      <div className="plan-stack">
        <div className="plan-bar">{legend}</div>
        <div className="weeks-stack">
          {[...current, ...upcoming].map((w, i) => column(w, i, i > 0))}
          {past.length > 0 && (
            <>
              <span className="t-label weeks-stack__divider">Earlier weeks</span>
              {past.map((w, i) => column(w, i + current.length + upcoming.length, true))}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="plan-run">
      <div className="plan-bar">
        {legend}
        <div className="plan-bar__nav">
          <Button variant="quiet" size="sm" onClick={toAnchor}>
            {raw >= 1 && raw <= W ? 'This week' : raw === 0 ? 'First week' : 'Last week'}
          </Button>
          <Button variant="ghost" size="sm" iconLeft="arrow-left" aria-label="Earlier weeks" onClick={() => step(-1)} disabled={!edges.left} />
          <Button variant="ghost" size="sm" iconLeft="arrow-right" aria-label="Later weeks" onClick={() => step(1)} disabled={!edges.right} />
        </div>
      </div>
      <div
        className={['weeks', edges.left && 'can-left', edges.right && 'can-right'].filter(Boolean).join(' ')}
        ref={scroller}
        onScroll={measure}
        role="list"
        aria-label="Weeks"
      >
        {plan.weeks.map((w, i) => column(w, Math.abs(i - (anchor - 1))))}
      </div>
    </div>
  );
}

function WeekColumn({
  week,
  phase,
  budget,
  name,
  order,
  collapsible,
  onTask,
  onCheckpoint,
}: {
  week: PlanWeek;
  phase: Phase;
  budget: number;
  name: (id: string) => string;
  order: number;
  collapsible: boolean;
  onTask: (t: PlanTask, s: TaskStatus) => void;
  onCheckpoint: (w: PlanWeek, passed: boolean) => void;
}) {
  const [open, setOpen] = useState(!collapsible);
  const load = weekLoad(week);
  const left = week.tasks.filter((t) => t.status === 'todo').length;
  const cls = ['week', `is-${phase}`, !open && 'is-folded'].filter(Boolean).join(' ');

  return (
    <motion.article
      className={cls}
      data-week={week.index}
      role="listitem"
      aria-current={phase === 'current' ? 'date' : undefined}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease, delay: 0.1 + Math.min(order, 8) * 0.05 }}
    >
      <header className="week__head">
        <div className="week__top">
          <span className="t-label week__index">
            Week <span className="t-num">{pad2(week.index)}</span>
            {phase === 'current' && <span className="week__now">This week</span>}
          </span>
          <span className="t-micro week__span">{weekSpan(week.startDate)}</span>
        </div>
        <h3 className="week__theme">{week.theme}</h3>
        {week.skillIds.length > 0 && (
          <div className="week__skills">
            {week.skillIds.map((id) => (
              <Chip key={id} size="sm">
                {name(id)}
              </Chip>
            ))}
          </div>
        )}
        <HoursBar planned={load.planned} done={load.done} budget={budget} />
      </header>

      {collapsible && (
        <button type="button" className="week__fold" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide tasks' : `Show ${week.tasks.length} tasks${!left ? ', all done' : left < week.tasks.length ? `, ${left} open` : ''}`}
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} />
        </button>
      )}

      {open && (
        <>
          {week.tasks.length ? (
            <ul className="week__tasks">
              {week.tasks.map((t) => (
                <TaskRow key={t.id} task={t} onStatus={onTask} />
              ))}
            </ul>
          ) : (
            <p className="week__empty">No tasks this week. It is held as a buffer.</p>
          )}
          <Checkpoint week={week} onSet={onCheckpoint} />
        </>
      )}
    </motion.article>
  );
}

function HoursBar({ planned, done, budget }: { planned: number; done: number; budget: number }) {
  const total = Math.max(planned, budget, 1);
  const pct = (n: number) => `${(Math.max(0, n) / total) * 100}%`;
  const over = round1(planned - budget);
  return (
    <div className="hbar">
      <div className="hbar__track" role="img" aria-label={`${round1(done)} of ${round1(planned)} hours done; budget ${budget} hours`}>
        <span className="hbar__planned" style={{ width: pct(Math.min(planned, budget)) }} />
        {over > 0 && <span className="hbar__over" style={{ left: pct(budget), width: pct(over) }} />}
        <motion.span className="hbar__done" initial={{ scaleX: 0 }} animate={{ scaleX: done / total }} transition={{ duration: 1, ease }} />
        <span className="hbar__budget" style={{ left: pct(budget) }} />
      </div>
      <div className="hbar__nums">
        <span className="t-num">
          <span className="hbar__done-n">{round1(done)}</span> / {hrs(planned)}
        </span>
        <span className={['t-micro', over > 0 && 't-accent'].filter(Boolean).join(' ')}>{over > 0 ? `${over} h over budget` : `Budget ${budget} h`}</span>
      </div>
    </div>
  );
}

function TaskRow({ task, onStatus }: { task: PlanTask; onStatus: (t: PlanTask, s: TaskStatus) => void }) {
  const done = task.status === 'done';
  const skipped = task.status === 'skipped';
  return (
    <li className={['task', done && 'is-done', skipped && 'is-skipped'].filter(Boolean).join(' ')}>
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        className="task__tick"
        disabled={skipped}
        onClick={() => onStatus(task, done ? 'todo' : 'done')}
        aria-label={`${task.title}: ${done ? 'mark as not done' : 'mark as done'}`}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <motion.path
            d="m5.5 10.4 3 3 6-6.8"
            fill="none"
            initial={false}
            animate={{ pathLength: done ? 1 : 0, opacity: done ? 1 : 0 }}
            transition={{ duration: 0.45, ease }}
          />
        </svg>
      </button>
      <div className="task__body">
        <p className="task__title">{task.title}</p>
        <div className="task__meta">
          <span className="task__left">
            <KindMark kind={task.kind} />
            <span className="t-num task__hours">{hrs(task.hours)}</span>
          </span>
          <button type="button" className="task__skip" onClick={() => onStatus(task, skipped ? 'todo' : 'skipped')}>
            {skipped ? 'Restore' : 'Skip'}
          </button>
        </div>
        {task.resource && (
          <a className="task__res" href={task.resource.url} target="_blank" rel="noreferrer">
            <span className="task__res-title">{task.resource.title}</span>
            <Icon name="arrow-up-right" size={12} />
            {task.resource.verified && (
              <span className="task__verified" title="The engine opened this link and it loaded">
                <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                  <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.1" />
                  <path d="m3.8 6.2 1.5 1.5 2.9-3.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                verified
              </span>
            )}
          </a>
        )}
      </div>
    </li>
  );
}

function Checkpoint({ week, onSet }: { week: PlanWeek; onSet: (w: PlanWeek, passed: boolean) => void }) {
  const p = week.checkpoint.passed;
  return (
    <div className={['checkpoint', p === true && 'is-passed', p === false && 'is-failed'].filter(Boolean).join(' ')}>
      <div className="checkpoint__top">
        <span className="t-label checkpoint__label">
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 11V1.5M2.5 2h6.5l-1.6 2.4L9 6.8H2.5" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
          </svg>
          Checkpoint
        </span>
        <span className="t-micro">due {dayLabel(addDays(week.startDate, 6))}</span>
      </div>
      <p className="checkpoint__title">{week.checkpoint.title}</p>
      <p className="checkpoint__desc">{week.checkpoint.description}</p>
      <div className="checkpoint__actions" role="group" aria-label={`Week ${week.index} checkpoint`}>
        <button type="button" className={['cp-btn cp-btn--pass', p === true && 'is-on'].filter(Boolean).join(' ')} aria-pressed={p === true} onClick={() => onSet(week, true)}>
          {p === true && <Icon name="check" size={13} />}
          Passed
        </button>
        <button type="button" className={['cp-btn cp-btn--fail', p === false && 'is-on'].filter(Boolean).join(' ')} aria-pressed={p === false} onClick={() => onSet(week, false)}>
          Not yet
        </button>
      </div>
      {p === false && <p className="checkpoint__note">The next replan adds a repair block for this week.</p>}
    </div>
  );
}

/* replan */

function MoveList({ plan, moved, limit }: { plan: PlanData; moved: string[]; limit?: number }) {
  const [all, setAll] = useState(false);
  if (!moved.length) return <p className="diff__none">Nothing had to move.</p>;
  const shown = limit && !all ? moved.slice(0, limit) : moved;
  return (
    <>
      <ul className="moves">
        {shown.map((m, i) => {
          const mv = readMove(plan, m);
          return (
            <li key={i} className="moves__item">
              <span className="moves__weeks t-num">
                {mv.to ? (
                  <>
                    {mv.from ? `W${pad2(mv.from)}` : ''}
                    {mv.from ? <Icon name="arrow-right" size={11} /> : null}
                    <span className="moves__to">W{pad2(mv.to)}</span>
                  </>
                ) : (
                  <span className="moves__dot" aria-hidden="true" />
                )}
              </span>
              <span className="moves__text">{mv.text}</span>
            </li>
          );
        })}
      </ul>
      {shown.length < moved.length && (
        <button type="button" className="moves__more" onClick={() => setAll(true)}>
          Show {moved.length - shown.length} more
          <Icon name="chevron-down" size={14} />
        </button>
      )}
    </>
  );
}

function DiffCard({ plan, change, onClose, onHistory }: { plan: PlanData; change: PlanChange; onClose: () => void; onHistory: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);
  return (
    <motion.section
      ref={ref}
      className="diff"
      aria-label="What moved and why"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6, transition: { duration: 0.3 } }}
      transition={{ duration: 0.8, ease }}
    >
      <div className="diff__head">
        <span className="t-label diff__label">
          <span className="t-accent t-num">v{versionOf(plan, change)}</span>
          What moved and why
        </span>
        <span className="diff__head-right">
          <span className="t-micro">{shortDate(change.at)}</span>
          <button type="button" className="diff__close" onClick={onClose} aria-label="Dismiss">
            <Icon name="close" size={15} />
          </button>
        </span>
      </div>
      <div className="diff__body">
        <div className="diff__why">
          <span className="t-label">Why</span>
          <p className="diff__reason">{change.reason}</p>
          <p className="diff__summary">{change.summary}</p>
          <Button variant="quiet" size="sm" icon="arrow-right" onClick={onHistory} className="diff__more">
            Earlier changes
          </Button>
        </div>
        <div className="diff__what">
          <span className="t-label">
            What moved <span className="t-num t-faint">{change.moved.length}</span>
          </span>
          <MoveList plan={plan} moved={change.moved} limit={5} />
        </div>
      </div>
    </motion.section>
  );
}

function ReplanModal({ open, onClose, onReplan, budget }: { open: boolean; onClose: () => void; onReplan: (reason?: string) => void; budget: number }) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Replan"
      title="Rebalance the weeks"
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="arrow-right" onClick={() => onReplan(reason.trim() || undefined)}>
            Replan
          </Button>
        </>
      }
    >
      <div className="replan-ask">
        <p className="t-mute">
          Late tasks roll forward into this week, weeks even out to your {budget} hours, closed skills free their hours, and a missed checkpoint adds a repair block.
          You see what moved and why straight after.
        </p>
        <TextField label="What changed (optional)" placeholder="Work ran late this week" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="replan-ask__chips">
          {REASONS.map((r) => (
            <Chip key={r} size="sm" selected={reason === r} onClick={() => setReason(reason === r ? '' : r)}>
              {r}
            </Chip>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function HistoryDrawer({ open, onClose, plan }: { open: boolean; onClose: () => void; plan: PlanData }) {
  const changes = changesNewestFirst(plan);
  const base = plan.version - changes.length;
  const when = (at: string) =>
    new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <Drawer open={open} onClose={onClose} width={640} eyebrow={`Version ${plan.version}`} title="How the plan changed">
      <ol className="hist">
        {changes.map((c, i) => (
          <li key={c.at} className={['hist__item', i === 0 && 'is-latest'].filter(Boolean).join(' ')}>
            <span className="hist__dot" aria-hidden="true" />
            <div className="hist__body">
              <div className="hist__top">
                <span className="t-num hist__v">v{plan.version - i}</span>
                <span className="t-micro">{when(c.at)}</span>
                {i === 0 && <span className="t-micro t-accent">Current</span>}
              </div>
              <h3 className="hist__reason">{c.reason}</h3>
              <p className="hist__summary">{c.summary}</p>
              <MoveList plan={plan} moved={c.moved} />
            </div>
          </li>
        ))}
        {base >= 1 && (
          <li className={['hist__item', !changes.length && 'is-latest'].filter(Boolean).join(' ')}>
            <span className="hist__dot" aria-hidden="true" />
            <div className="hist__body">
              <div className="hist__top">
                <span className="t-num hist__v">v{base}</span>
                <span className="t-micro">{when(plan.createdAt)}</span>
              </div>
              <h3 className="hist__reason">Plan built from the gap map</h3>
              <p className="hist__summary">
                {plan.weeks.length} weeks, {plan.weeks.reduce((a, w) => a + w.tasks.length, 0)} tasks.
              </p>
            </div>
          </li>
        )}
      </ol>
    </Drawer>
  );
}

/* states */

function BuildLoader({ since }: { since: number }) {
  const latest = useLatestTrace(since);
  const text = latest ? `${latest.step} ${latest.detail}` : '';
  const stage = /resource|verif/i.test(text) ? 2 : /word|llm|task/i.test(text) ? 1 : 0;
  return (
    <BlueprintLoader
      label="Planning the weeks"
      detail={latest ? `${latest.step} · ${latest.detail}` : 'Placing each open skill into a week inside your hours'}
      stages={['Allocate skills to weeks', 'Write tasks and checkpoints', 'Link resources']}
      stage={stage}
      height={260}
    />
  );
}

function EmptyPlan({ hasGap, openSkills, budget, weeks, onBuild }: { hasGap: boolean; openSkills?: number; budget: number; weeks: number; onBuild: () => void }) {
  if (!hasGap) {
    return (
      <EmptyState
        eyebrow="No plan yet"
        title="Map the gap first"
        body="The plan is built from the gap map: each open skill gets a week, tasks sized to your hours and a checkpoint."
        action={
          <Button variant="primary" icon="arrow-right" to="/gap">
            Open the gap map
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      eyebrow="No plan yet"
      title="Turn the gap into weeks"
      body={`Tack places ${openSkills ? `the ${openSkills} open skills` : 'each open skill'} into ${weeks} weeks of ${budget} hours, highest priority first, with tasks, resources and a checkpoint at the end of each week.`}
      action={
        <Button variant="primary" icon="arrow-right" onClick={onBuild}>
          Build my plan
        </Button>
      }
    />
  );
}

function PlanSkeleton() {
  return (
    <div className="plan-skeleton" aria-busy="true">
      <Skeleton height={132} radius={16} />
      <div className="plan-skeleton__cols">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="plan-skeleton__col">
            <Skeleton width={80} height={10} />
            <Skeleton width="80%" height={20} />
            <Skeleton height={4} />
            <Skeleton lines={3} height={12} />
            <Skeleton lines={3} height={12} />
            <Skeleton height={110} radius={12} />
          </div>
        ))}
      </div>
    </div>
  );
}
