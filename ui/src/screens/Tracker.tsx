import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { api } from '../api/client';
import { actions, useAppState, useApplications, useInsights, usePostings } from '../api/hooks';
import { applying, isActive, useBatches, useRunFor } from '../api/applying';
import { useQuery } from '../api/query';
import type { Posting, Segment, SyncResult, TrackerInsights } from '../api/types';
import { hostOf, pad2 } from '../lib/format';
import { Button, Card, Chip, EmptyState, ErrorState, Icon, PageHeader, Skeleton, ease, useToast } from '../ui';
import { AddApplication, AppDrawer, Pipeline, SectionHead } from './tracker/Pipeline';
import { chance, groupSegments, isWinner, pctOf, segKey, segmentValue } from './tracker/model';
import { KitSheet, type KitTarget } from './kit/KitSheet';
import { BatchPanel } from './tracker/ApplyRuns';
import { MailStrip, WhatChanged } from './tracker/Mail';
import './Tracker.css';

export function Tracker() {
  const apps = useApplications();
  const insights = useInsights();
  const postings = usePostings();
  const { data: state } = useAppState();
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string>();
  const [changed, setChanged] = useState<SyncResult>();

  const all = apps.data ?? [];
  const open = all.find((a) => a.id === openId);

  return (
    <div className="tr">
      <PageHeader
        index="06"
        section="Tracker"
        title="Who replies, and why"
        purpose="Every application, where it stands, and what the replies say about where to aim next. Move a card and the numbers relearn."
        actions={
          apps.data ? (
            <Button variant="primary" iconLeft="plus" onClick={() => setAdding(true)}>
              Add application
            </Button>
          ) : undefined
        }
      />

      {apps.error && !apps.data ? (
        <ErrorState title="Could not load applications" message={apps.error.message} onRetry={() => apps.refetch().catch(() => undefined)} />
      ) : apps.loading ? (
        <TrackerSkeleton />
      ) : all.length === 0 ? (
        <>
          <EmptyState
            eyebrow="No applications yet"
            title="Nothing to learn from yet"
            body={
              state?.profile
                ? 'Switch the autopilot on and Tack applies to the best-ranked postings by itself, or apply to one below. After about a dozen, the tracker starts to show which kinds of roles reply.'
                : 'Add a résumé and read the market first, or load the demo person to see the tracker with 24 applications.'
            }
            action={
              state?.profile ? (
                <div className="tr__empty-actions">
                  <Button variant="primary" icon="arrow-right" to="/autopilot">
                    Open Autopilot
                  </Button>
                  <Button variant="ghost" iconLeft="plus" onClick={() => setAdding(true)}>
                    Add application
                  </Button>
                </div>
              ) : (
                <Button variant="primary" icon="arrow-right" to="/">
                  Go to Start
                </Button>
              )
            }
          />
          {insights.data && insights.data.next.length > 0 && (
            <div className="tr__gap">
              <ApplyNext insights={insights.data} postings={postings.data} engineOn={!!state?.engine.available} />
            </div>
          )}
        </>
      ) : (
        <>
          <MailStrip onResult={setChanged} />
          {changed && <WhatChanged result={changed} onClose={() => setChanged(undefined)} />}
          {insights.error && !insights.data ? (
            <section className="section">
              <SectionHead index="01" title="What gets replies" />
              <ErrorState title="Could not load the insights" message={insights.error.message} onRetry={() => insights.refetch().catch(() => undefined)} />
            </section>
          ) : !insights.data ? (
            <RepliesSkeleton />
          ) : (
            <Replies insights={insights.data} fetching={insights.fetching} sample={all.filter((a) => a.origin === 'demo').length} />
          )}

          {insights.data && <ApplyNext insights={insights.data} postings={postings.data} engineOn={!!state?.engine.available} />}

          <Pipeline apps={all} onOpen={setOpenId} />
        </>
      )}

      <AppDrawer app={open} onClose={() => setOpenId(undefined)} />
      <AddApplication open={adding} onClose={() => setAdding(false)} postings={postings.data ?? []} />
    </div>
  );
}

/* what gets replies */

function useChanged(insights: TrackerInsights) {
  const prev = useRef<Map<string, Segment>>(undefined);
  const [changed, setChanged] = useState<{ keys: Set<string>; at: number }>({ keys: new Set(), at: 0 });
  useEffect(() => {
    const now = new Map(insights.segments.map((s) => [segKey(s), s]));
    const before = prev.current;
    prev.current = now;
    if (!before) return;
    const moved = new Set<string>();
    for (const [k, s] of now) {
      const b = before.get(k);
      if (!b || b.sent !== s.sent || b.responses !== s.responses) moved.add(k);
    }
    for (const k of before.keys()) if (!now.has(k)) moved.add(k);
    if (!moved.size) return;
    setChanged({ keys: moved, at: Date.now() });
    const t = window.setTimeout(() => setChanged((c) => ({ ...c, keys: new Set() })), 3200);
    return () => window.clearTimeout(t);
  }, [insights]);
  return changed;
}

function Replies({ insights, fetching, sample }: { insights: TrackerInsights; fetching: boolean; sample: number }) {
  const { overall, lessons } = insights;
  const groups = useMemo(() => groupSegments(insights.segments), [insights.segments]);
  const changed = useChanged(insights);
  const [more, setMore] = useState(false);
  const scaleMax = Math.min(1, Math.max(0.5, ...insights.segments.map((s) => s.rate), overall.rate) * 1.08);
  const shownLessons = more ? lessons : lessons.slice(0, 4);

  return (
    <section className="section">
      <SectionHead
        index="01"
        title="What gets replies"
        text="A reply, an interview or an offer counts as a response. Each bar is the reply rate for one kind of application; the tick marks your overall rate."
        aside={
          <span className={['relearn t-micro', (fetching || changed.keys.size > 0) && 'is-on'].filter(Boolean).join(' ')} aria-live="polite">
            {fetching ? (
              <>
                <span className="pulse-dot" /> Relearning
              </>
            ) : changed.keys.size > 0 ? (
              `Relearned · ${changed.keys.size} segment${changed.keys.size === 1 ? '' : 's'} moved`
            ) : (
              `Learned from ${overall.sent}${sample ? ' sample' : ''} application${overall.sent === 1 ? '' : 's'}`
            )}
          </span>
        }
      />

      <Card pad="lg" className="replies" settle>
        {sample > 0 && (
          <p className="replies__sample">
            <span className="origin origin--demo">sample</span>
            {sample === overall.sent
              ? `Learning from sample data: these ${sample} applications come with the demo person, so the patterns below are illustrative, not yours.`
              : `${sample} of these ${overall.sent} applications are sample data that came with the demo person; the patterns lean on them until yours outnumber them.`}
          </p>
        )}
        <div className="replies__overall">
          <span className="t-label">Response rate</span>
          <motion.span key={overall.rate} className="replies__rate t-num" initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, ease }}>
            {pctOf(overall.rate)}
          </motion.span>
          <div className="replies__counts">
            <span>
              <span className="t-num replies__n">{overall.responses}</span> responses
            </span>
            <span className="t-faint">from</span>
            <span>
              <span className="t-num replies__n">{overall.sent}</span> sent
            </span>
          </div>
          <div className="conf-key" aria-label="Confidence marks">
            <span className="t-label">Evidence</span>
            <ul>
              <li>
                <Confidence level="low" /> Under 5 sent
              </li>
              <li>
                <Confidence level="medium" /> 5 to 11
              </li>
              <li>
                <Confidence level="high" /> 12 or more
              </li>
            </ul>
          </div>
        </div>
        <div className="replies__lessons">
          <span className="t-label">What the replies say</span>
          <ol className="lessons">
            {shownLessons.map((l, i) => (
              <motion.li key={l} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, ease, delay: 0.2 + i * 0.08 }}>
                <span className="t-num lessons__n">{pad2(i + 1)}</span>
                <p>{l}</p>
              </motion.li>
            ))}
          </ol>
          {lessons.length > 4 && (
            <Button variant="quiet" size="sm" iconLeft={more ? 'chevron-up' : 'chevron-down'} onClick={() => setMore((v) => !v)}>
              {more ? 'Fewer' : `${lessons.length - 4} more`}
            </Button>
          )}
        </div>
      </Card>

      <div className="segs" data-count={groups.length}>
        {groups.map((g, gi) => (
          <Card key={g.key} pad="md" className="seg-card" label={g.label} aside={<span className="t-micro">{g.rows.length}</span>} settle={0.06 + gi * 0.05}>
            <ul className="seg-rows">
              {g.rows.map((s) => (
                <SegmentRow key={segKey(s)} s={s} overall={overall.rate} max={scaleMax} changed={changed.keys.has(segKey(s))} />
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </section>
  );
}

function SegmentRow({ s, overall, max, changed }: { s: Segment; overall: number; max: number; changed: boolean }) {
  const win = isWinner(s);
  const thin = s.confidence === 'low';
  const below = s.lift <= 0.8;
  return (
    <li className={['seg', win && 'is-win', thin && 'is-thin', below && 'is-below', changed && 'is-changed'].filter(Boolean).join(' ')}>
      <div className="seg__top">
        <span className="seg__name">{segmentValue(s.dimension, s.value)}</span>
        <Confidence level={s.confidence} />
      </div>
      <div className="seg__row">
        <span className="seg__track" aria-hidden="true">
          <motion.span className="seg__fill" initial={{ scaleX: 0 }} animate={{ scaleX: Math.max(0.01, s.rate / max) }} transition={{ duration: 1, ease }} />
          <span className="seg__tick" style={{ left: `${(overall / max) * 100}%` }} />
        </span>
        <span className="seg__rate t-num">{pctOf(s.rate)}</span>
        <span className="seg__n t-num" title={`${s.responses} responses from ${s.sent} sent`}>
          {s.responses}/{s.sent}
        </span>
        <span className="seg__lift t-num" title="Lift against your overall rate">
          {s.lift.toFixed(1)}×
        </span>
      </div>
      <span className="visually-hidden">
        {segmentValue(s.dimension, s.value)}: {s.responses} responses from {s.sent} sent, {s.lift.toFixed(1)} times your average, {s.confidence} confidence.
      </span>
    </li>
  );
}

export function Confidence({ level }: { level: Segment['confidence'] }) {
  const n = level === 'high' ? 3 : level === 'medium' ? 2 : 1;
  return (
    <svg className={`conf conf--${level}`} width="13" height="10" viewBox="0 0 13 10" role="img" aria-label={`${level} confidence`}>
      <title>{`${level[0].toUpperCase()}${level.slice(1)} confidence`}</title>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={i * 4.5} y={6 - i * 3} width="3.2" height={4 + i * 3} rx="0.8" className={i < n ? 'is-on' : undefined} />
      ))}
    </svg>
  );
}

/* apply next */

function ApplyNext({ insights, postings, engineOn }: { insights: TrackerInsights; postings?: Posting[]; engineOn: boolean }) {
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [n, setN] = useState(3);
  const [kitFor, setKitFor] = useState<KitTarget>();
  const toast = useToast();
  const batches = useBatches();
  const ready = useQuery('apply-readiness', () => api.readiness());
  const running = batches.some((b) => b.runs.some(isActive));
  const list = all ? insights.next : insights.next.slice(0, 5);
  const blocked = ready.data && !ready.data.ready ? ready.data.reason : undefined;
  const practice = ready.data?.target === 'practice';

  const start = async (label: string, work: () => Promise<{ note: string }>) => {
    setBusy(label);
    try {
      const res = await work();
      toast({
        title: res.note,
        body: practice ? 'Each one opens in its own Chrome window. Practice applications go to Tack\'s form, never to the company.'
          : ready.data?.dryRun ? 'Each one opens in its own Chrome window and is filled, never submitted.'
            : ready.data?.consent ? 'Each one opens in its own Chrome window and is submitted on your standing consent.'
              : 'Each one opens in its own Chrome window and stops before Submit: you have not given standing consent.',
      });
    } catch (e) {
      toast({ title: 'Could not start applying', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(undefined);
    }
  };

  const mark = async (x: TrackerInsights['next'][number]) => {
    setBusy(`mark:${x.postingId}`);
    const p = postings?.find((y) => y.id === x.postingId);
    try {
      await actions.addApplication({
        postingId: x.postingId,
        title: x.title,
        company: x.company,
        url: x.url,
        fit: x.fit,
        ...(p?.roleFamily ? { roleFamily: p.roleFamily } : {}),
        ...(p?.seniority ? { seniority: p.seniority } : {}),
        ...(p?.companySize ? { companySize: p.companySize } : {}),
        ...(p?.source ? { source: p.source } : {}),
      });
      toast({ title: `${x.company} is in Applied`, body: 'The ranking below and the numbers above now count it.', tone: 'success' });
    } catch (e) {
      toast({ title: 'Could not log it', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className="section">
      <SectionHead
        index="02"
        title="Apply next"
        text="Postings you have not applied to, ranked by fit and by how often that kind of role has replied to you so far."
        aside={
          <Chip size="sm" mono tone={engineOn ? 'olive' : 'mute'}>
            {practice ? 'Practice applications' : engineOn ? 'Engine attached' : 'Engine off'}
          </Chip>
        }
      />
      {insights.next.length > 0 && (
        <div className="topn">
          <div className="topn__pick" role="group" aria-label="How many to apply to">
            <button type="button" className="topn__btn" onClick={() => setN((v) => Math.max(1, v - 1))} disabled={n <= 1} aria-label="One fewer">
              <Icon name="minus" size={14} />
            </button>
            <span className="topn__n t-num" aria-live="polite">{n}</span>
            <button type="button" className="topn__btn" onClick={() => setN((v) => Math.min(8, Math.min(insights.next.length, v + 1)))} disabled={n >= Math.min(8, insights.next.length)} aria-label="One more">
              <Icon name="plus" size={14} />
            </button>
          </div>
          <Button variant="primary" icon="arrow-right" onClick={() => start('top', () => applying.top(n))} loading={busy === 'top'} disabled={!!blocked || running || (!!busy && busy !== 'top')}>
            Apply to top {n}
          </Button>
          <p className="topn__note">
            {blocked ? (
              <>
                <Icon name="warning" size={14} /> {blocked}
              </>
            ) : (
              `${n === 1 ? 'One Chrome window' : `${n} Chrome windows working at the same time`}, each filled by the engine. ${practice ? 'The demo person applies to Tack\'s practice form, never to a company.'
                : ready.data?.dryRun ? 'Dry run: forms are filled for real and never submitted.'
                  : ready.data?.consent ? 'Each is submitted on your standing consent, with no review step.' : 'Each stops before Submit until you give standing consent under Application details on Start.'}`
            )}
          </p>
        </div>
      )}
      {batches.map((b) => (
        <BatchPanel key={b.id} batch={b} />
      ))}
      {insights.next.length === 0 ? (
        <EmptyState compact eyebrow="Nothing ranked" title="No postings left to rank" body="Every posting Tack read is already in the pipeline. Read the market again for fresh ones." />
      ) : (
        <ol className="next">
          {list.map((x, i) => (
            <NextRow
              key={x.postingId}
              x={x}
              i={i}
              busy={busy}
              blocked={blocked}
              onApply={() => start(`apply:${x.postingId}`, () => applying.start([x.postingId]))}
              onKit={() => setKitFor({ postingId: x.postingId, title: x.title, company: x.company, url: x.url })}
              onMark={() => mark(x)}
            />
          ))}
        </ol>
      )}
      {insights.next.length > 5 && (
        <Button variant="quiet" size="sm" iconLeft={all ? 'chevron-up' : 'chevron-down'} onClick={() => setAll((v) => !v)} className="next__more">
          {all ? 'Show the top five' : `Show all ${insights.next.length}`}
        </Button>
      )}
      <KitSheet target={kitFor} onClose={() => setKitFor(undefined)} />
    </section>
  );
}

function NextRow({ x, i, busy, blocked, onApply, onKit, onMark }: {
  x: TrackerInsights['next'][number]; i: number; busy?: string; blocked?: string;
  onApply: () => void; onKit: () => void; onMark: () => void;
}) {
  const run = useRunFor(x.postingId);
  const c = chance(x.responseChance);
  const live = run && isActive(run);
  return (
    <motion.li
      className="nx"
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.7, ease, delay: Math.min(i, 8) * 0.04 }}
    >
      <span className="nx__rank t-num">{pad2(i + 1)}</span>
      <div className="nx__main">
        <span className="nx__title">{x.title}</span>
        <span className="nx__company">
          {x.company}
          {x.url && <span className="t-faint"> · {hostOf(x.url)}</span>}
        </span>
        <p className="nx__why">{x.why}</p>
        {run && (
          <p className={['nx__note', run.status === 'failed' ? 'is-back' : 'is-started'].join(' ')} role="status">
            <Icon name={run.status === 'failed' ? 'warning' : 'check'} size={14} />
            <span>
              <b>{run.status === 'applied' ? 'Submitted.' : run.status === 'failed' ? 'Not sent.' : 'Applying now.'}</b>{' '}
              {run.status === 'applied' ? run.confirmation : run.status === 'failed' ? run.reason : run.steps.at(-1)?.label ?? 'Opening a browser window'}
            </span>
          </p>
        )}
      </div>
      <div className="nx__figs">
        <span className="nx__fig">
          <span className="t-label">Fit</span>
          <span className="t-num nx__v">{x.fit}</span>
        </span>
        <span className="nx__fig">
          <span className="t-label">Reply chance</span>
          <span className={['t-num nx__v', c >= 0.45 && 'is-hi'].filter(Boolean).join(' ')}>{pctOf(c)}</span>
        </span>
      </div>
      <div className="nx__acts">
        <Button
          variant="primary"
          size="sm"
          icon="arrow-right"
          onClick={onApply}
          loading={busy === `apply:${x.postingId}` || live}
          disabled={!!blocked || run?.status === 'applied' || (!!busy && busy !== `apply:${x.postingId}`)}
          title={blocked}
        >
          {run?.status === 'applied' ? 'Applied' : 'Apply'}
        </Button>
        <Button variant="ghost" size="sm" iconLeft="file" onClick={onKit}>
          Prepare application
        </Button>
        <Button variant="ghost" size="sm" iconLeft="check" onClick={onMark} loading={busy === `mark:${x.postingId}`} disabled={!!busy && busy !== `mark:${x.postingId}`}>
          Mark applied
        </Button>
      </div>
    </motion.li>
  );
}

/* loading */

function RepliesSkeleton() {
  return (
    <div className="section" aria-busy="true">
      <Skeleton width={180} height={12} />
      <Skeleton width="36%" height={34} />
      <Skeleton height={260} radius={16} />
      <div className="segs">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} height={200} radius={16} />
        ))}
      </div>
    </div>
  );
}

function TrackerSkeleton() {
  return (
    <div aria-busy="true">
      <RepliesSkeleton />
      <div className="board board--ghost">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="col">
            <Skeleton width="60%" height={10} />
            <Skeleton height={92} radius={12} />
            {i % 2 === 0 && <Skeleton height={92} radius={12} />}
          </div>
        ))}
      </div>
    </div>
  );
}
