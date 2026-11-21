import { useMemo } from 'react';
import { Link } from 'react-router';
import { motion } from 'motion/react';
import type { Brief, BriefItem } from '../api/client';
import { useAppState, useBrief, useGap, useInterviews, usePlan, useProgress } from '../api/hooks';
import type { QueryResult } from '../api/query';
import type { GapMap, InterviewSession, Plan, Progress as ProgressData } from '../api/types';
import { pad2, shortDate } from '../lib/format';
import { Button, Card, EmptyState, ErrorState, Icon, PageHeader, Skeleton, Stat, ease } from '../ui';
import { changesNewestFirst, currentWeek, weekLoad, weekOfToday } from './plan/weeks';
import { HoursChart, ReadinessChart, ScoreChart, StreakTicks } from './progress/Charts';
import './Progress.css';

// The API has no readiness goal, so the line marks the point where most must-haves are covered.
const TARGET = 80;

const KIND_LABEL: Record<string, string> = {
  task: 'Plan task',
  replan: 'Replan',
  checkpoint: 'Checkpoint',
  interview: 'Interview',
  apply: 'Apply',
  setup: 'Set up',
};

const ACTION_ROUTE: Record<string, string> = {
  'open start': '/',
  'build plan': '/plan',
  'open plan': '/plan',
  replan: '/plan?replan=1',
  'mark checkpoint': '/plan',
  'start interview': '/interview',
  apply: '/tracker',
};

const KIND_ROUTE: Record<string, [string, string]> = {
  task: ['/plan', 'Open plan'],
  replan: ['/plan?replan=1', 'Replan'],
  checkpoint: ['/plan', 'Mark checkpoint'],
  interview: ['/interview', 'Start interview'],
  apply: ['/tracker', 'Apply'],
  setup: ['/', 'Open Start'],
};

/** The coach sends an action label ("Open plan"); older data may send a path. */
function actionFor(item: BriefItem): { to: string; label: string } {
  const [kindTo, kindLabel] = KIND_ROUTE[item.kind] ?? ['/plan', 'Open'];
  if (!item.action) return { to: kindTo, label: kindLabel };
  if (item.action.startsWith('/')) return { to: item.action, label: kindLabel };
  return { to: ACTION_ROUTE[item.action.toLowerCase()] ?? kindTo, label: item.action };
}

export function Progress() {
  const progress = useProgress();
  const brief = useBrief();
  const plan = usePlan();
  const gap = useGap();
  const interviews = useInterviews();
  const { data: state } = useAppState();
  const p = progress.data;
  const budget = state?.goal?.hoursPerWeek ?? 10;
  const nothing = p && !p.readiness.length && !p.tasksTotal && !p.interviewAvg.length;

  return (
    <div className="prog">
      <PageHeader
        index="07"
        section="Progress"
        title="How far you have come"
        purpose="Readiness over time, hours put in, your streak, and the three things worth doing today."
      />

      <BriefHero q={brief} />

      {progress.error && !p ? (
        <ErrorState title="Could not load progress" message={progress.error.message} onRetry={() => progress.refetch().catch(() => undefined)} />
      ) : !p ? (
        <ProgressSkeleton />
      ) : nothing ? (
        <EmptyState
          eyebrow="Nothing to measure yet"
          title="Progress starts with the gap map"
          body="Readiness is recorded every time the gap map changes, and hours come from the plan. Load a résumé and read the market to start the line."
          action={
            <Button variant="primary" icon="arrow-right" to="/">
              Go to Start
            </Button>
          }
        />
      ) : (
        <>
          <Numbers p={p} />

          <div className="prog__grid prog__grid--a">
            <Card pad="md" index="01" label="Readiness over time" aside={<span className="t-micro">Start to today</span>} className="prog__card" settle={0.05}>
              <ReadinessChart points={p.readiness} target={TARGET} />
            </Card>
            <Verdict p={p} />
          </div>

          <div className="prog__grid prog__grid--b">
            <Card
              pad="md"
              index="02"
              label="Hours by week"
              aside={
                <span className="chart-key">
                  <span className="chart-key__item">
                    <i className="chart-key__done" />
                    Done
                  </span>
                  <span className="chart-key__item">
                    <i className="chart-key__planned" />
                    Planned
                  </span>
                  <span className="chart-key__item">
                    <i className="chart-key__line" />
                    Budget {budget} h
                  </span>
                </span>
              }
              className="prog__card"
              settle={0.1}
            >
              <HoursBlock plan={plan.data} loading={plan.loading} budget={budget} />
            </Card>
            <Card pad="md" index="03" label="Interview average" className="prog__card" settle={0.15}>
              <Interviews points={p.interviewAvg} />
            </Card>
          </div>

          <Feed plan={plan.data ?? undefined} gap={gap.data ?? undefined} sessions={interviews.data ?? []} />
        </>
      )}
    </div>
  );
}

/* today's brief */

function BriefHero({ q }: { q: QueryResult<Brief> }) {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  if (q.error && !q.data) {
    return (
      <div className="brief-wrap">
        <ErrorState compact title="Could not load today's brief" message={q.error.message} onRetry={() => q.refetch().catch(() => undefined)} />
      </div>
    );
  }
  const b = q.data;
  return (
    <Card pad="lg" className="brief" settle>
      <div className="brief__top">
        <span className="t-label">
          <span className="t-accent">Today</span>
        </span>
        <span className="brief__rule" />
        <span className="t-micro">{today}</span>
      </div>
      {b ? (
        <motion.h2 className="brief__headline" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, ease, delay: 0.15 }}>
          {b.headline}
        </motion.h2>
      ) : (
        <div className="brief__headline-skel">
          <Skeleton height={34} width="78%" />
          <Skeleton height={34} width="46%" />
        </div>
      )}
      <ol className="brief__items" style={{ ['--n' as string]: b ? Math.max(1, b.items.length) : 3 }}>
        {b
          ? b.items.map((it, i) => {
              const a = actionFor(it);
              return (
                <motion.li
                  key={`${it.kind}-${i}`}
                  className="brief__item"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.8, ease, delay: 0.25 + i * 0.08 }}
                >
                  <span className="brief__meta">
                    <span className="t-num brief__no">{pad2(i + 1)}</span>
                    <span className="t-label">{KIND_LABEL[it.kind] ?? it.kind}</span>
                  </span>
                  <p className="brief__text">{it.text}</p>
                  <Button variant={i === 0 ? 'primary' : 'ghost'} size="sm" icon="arrow-right" to={a.to} className="brief__go">
                    {a.label}
                  </Button>
                </motion.li>
              );
            })
          : [0, 1, 2].map((i) => (
              <li key={i} className="brief__item">
                <Skeleton width={90} height={10} />
                <Skeleton lines={2} height={14} />
                <Skeleton width={110} height={34} radius={17} />
              </li>
            ))}
      </ol>
    </Card>
  );
}

/* numbers row */

function Numbers({ p }: { p: ProgressData }) {
  const r = p.readiness;
  const now = r.length ? r[r.length - 1].value : undefined;
  const start = r.length ? r[0].value : undefined;
  const iv = p.interviewAvg;
  const lastIv = iv.length ? iv[iv.length - 1].value : undefined;
  const prevIv = iv.length > 1 ? iv[iv.length - 2].value : undefined;
  return (
    <Card pad="md" className="nums" settle>
      <div className="nums__cell">
        <Stat
          label="Readiness"
          value={now !== undefined ? <span className="t-accent">{Math.round(now)}</span> : '–'}
          unit="/100"
          delta={now !== undefined && start !== undefined && r.length > 1 ? Math.round(now - start) : undefined}
          note={start !== undefined && r.length > 1 ? `from ${Math.round(start)} at the start` : 'one reading so far'}
        />
      </div>
      <div className="nums__cell">
        <Stat label="Hours" value={p.hoursDone} unit={`of ${p.hoursPlanned} h`} note={`${p.tasksDone} of ${p.tasksTotal} tasks done`} />
      </div>
      <div className="nums__cell">
        <Stat label="Skills closed" value={p.skillsClosed} note="through the plan and interviews" />
      </div>
      <div className="nums__cell">
        <Stat label="Streak" value={p.streakDays} unit={p.streakDays === 1 ? 'day' : 'days'} />
        <StreakTicks days={p.streakDays} />
      </div>
      <div className="nums__cell">
        <Stat
          label="Interview avg"
          value={lastIv ?? '–'}
          unit={lastIv !== undefined ? '/100' : undefined}
          delta={lastIv !== undefined && prevIv !== undefined ? lastIv - prevIv : undefined}
          note={iv.length ? `${iv.length} finished session${iv.length > 1 ? 's' : ''}` : 'no finished sessions'}
        />
      </div>
    </Card>
  );
}

function Verdict({ p }: { p: ProgressData }) {
  return (
    <Card pad="md" label="Verdict" className={['verdict prog__card', p.onTrack ? 'is-on' : 'is-off'].join(' ')} settle={0.1}>
      <div className="verdict__body">
        <span className="verdict__word">
          <span className="verdict__dot" aria-hidden="true" />
          {p.onTrack ? 'On track' : 'Behind'}
        </span>
        <p className="verdict__note">{p.note}</p>
      </div>
      <div className="verdict__foot">
        <div className="verdict__pct">
          <span className="t-label">Tasks</span>
          <span className="t-num">
            {p.tasksDone}
            <span className="t-faint">/{p.tasksTotal}</span>
          </span>
        </div>
        {p.onTrack ? (
          <Button variant="ghost" size="sm" icon="arrow-right" to="/plan">
            Open the plan
          </Button>
        ) : (
          <Button variant="primary" size="sm" icon="arrow-right" to="/plan?replan=1">
            Replan
          </Button>
        )}
      </div>
    </Card>
  );
}

function HoursBlock({ plan, loading, budget }: { plan?: Plan | null; loading: boolean; budget: number }) {
  if (loading) return <Skeleton height={220} radius={10} />;
  if (!plan) {
    return (
      <div className="chart-none">
        <p>No plan yet. Hours appear here week by week once the plan is built.</p>
        <Button variant="ghost" size="sm" icon="arrow-right" to="/plan">
          Build my plan
        </Button>
      </div>
    );
  }
  const raw = weekOfToday(plan);
  const weeks = plan.weeks.map((w) => ({ index: w.index, ...weekLoad(w) }));
  return <HoursChart weeks={weeks} budget={budget} current={raw >= 1 && raw <= plan.weeks.length ? currentWeek(plan) : undefined} />;
}

function Interviews({ points }: { points: ProgressData['interviewAvg'] }) {
  if (!points.length) {
    return (
      <div className="chart-none">
        <p>No finished mock interviews yet. Each session is scored out of 100.</p>
        <Button variant="ghost" size="sm" icon="arrow-right" to="/interview">
          Start an interview
        </Button>
      </div>
    );
  }
  const last = points[points.length - 1].value;
  const best = Math.max(...points.map((x) => x.value));
  return (
    <div className="iv">
      <div className="iv__top">
        <span className="iv__n t-num">
          <span className="t-accent">{last}</span>
          <span className="iv__unit">latest</span>
        </span>
        <span className="t-micro iv__best">Best {best} · below 50 adds practice</span>
      </div>
      <ScoreChart points={points} />
    </div>
  );
}

/* what changed */

interface FeedItem {
  at: string;
  kind: 'plan' | 'interview' | 'skill';
  title: string;
  body?: string;
  to: string;
}

const FEED_LABEL: Record<FeedItem['kind'], string> = { plan: 'Plan', interview: 'Interview', skill: 'Skill closed' };
const KIND_NAME: Record<InterviewSession['kind'], string> = { behavioural: 'Behavioural', technical: 'Technical', case: 'Case', mixed: 'Mixed' };

function buildFeed(plan: Plan | undefined, gap: GapMap | undefined, sessions: InterviewSession[]): FeedItem[] {
  const out: FeedItem[] = [];
  if (plan) {
    const changes = changesNewestFirst(plan);
    changes.forEach((c, i) => out.push({ at: c.at, kind: 'plan', title: `Plan v${plan.version - i}: ${c.reason}`, body: c.summary, to: '/plan' }));
    const base = plan.version - changes.length;
    if (base >= 1) out.push({ at: plan.createdAt, kind: 'plan', title: `Plan v${base} built`, body: `${plan.weeks.length} weeks from the gap map.`, to: '/plan' });
  }
  for (const s of sessions) {
    if (!s.finishedAt || s.score === undefined || s.score === null) continue;
    out.push({ at: s.finishedAt, kind: 'interview', title: `${KIND_NAME[s.kind] ?? 'Mock'} interview scored ${s.score}`, body: `${s.turns.length} answer${s.turns.length === 1 ? '' : 's'} scored on five criteria.`, to: '/interview' });
  }
  // a closed skill has no date of its own; use the last finished task that worked on it
  const doneBySkill = new Map<string, string>();
  for (const w of plan?.weeks ?? []) {
    for (const t of w.tasks) {
      if (t.status !== 'done' || !t.doneAt) continue;
      for (const id of t.skillIds) if ((doneBySkill.get(id) ?? '') < t.doneAt) doneBySkill.set(id, t.doneAt);
    }
  }
  for (const s of gap?.skills ?? []) {
    const at = doneBySkill.get(s.id);
    if (s.status !== 'closed' || !at) continue;
    out.push({ at, kind: 'skill', title: `${s.name} closed`, body: `Have ${s.have} of the ${s.need} the role needs.`, to: '/gap' });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
}

function Feed({ plan, gap, sessions }: { plan?: Plan; gap?: GapMap; sessions: InterviewSession[] }) {
  const items = useMemo(() => buildFeed(plan, gap, sessions), [plan, gap, sessions]);
  return (
    <section className="feed" aria-labelledby="feed-title">
      <div className="feed__head">
        <span className="t-label" id="feed-title">
          <span className="t-faint">04</span> What changed
        </span>
        <span className="t-micro">Plan changes, finished interviews and closed skills</span>
      </div>
      {items.length ? (
        <ol className="feed__list">
          {items.map((it, i) => (
            <motion.li key={`${it.kind}-${it.at}-${i}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, ease, delay: 0.1 + i * 0.04 }}>
              <Link to={it.to} className="feed__item">
                <span className="t-num feed__date">{shortDate(it.at)}</span>
                <span className={`feed__kind feed__kind--${it.kind}`}>{FEED_LABEL[it.kind]}</span>
                <span className="feed__text">
                  <span className="feed__title">{it.title}</span>
                  {it.body && <span className="feed__body">{it.body}</span>}
                </span>
                <Icon name="arrow-right" size={15} className="feed__arrow" />
              </Link>
            </motion.li>
          ))}
        </ol>
      ) : (
        <EmptyState compact eyebrow="Quiet so far" title="Nothing has changed yet" body="Replans, finished interviews and skills you close show up here." />
      )}
    </section>
  );
}

function ProgressSkeleton() {
  return (
    <div className="prog-skeleton" aria-busy="true">
      <Skeleton height={120} radius={16} />
      <div className="prog__grid prog__grid--a">
        <Skeleton height={320} radius={16} />
        <Skeleton height={320} radius={16} />
      </div>
    </div>
  );
}
