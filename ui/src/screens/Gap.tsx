import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { motion } from 'motion/react';
import { actions, useAppState, useGap, usePlan, usePostings } from '../api/hooks';
import type { GapMap, GapSkill, Level, Plan } from '../api/types';
import { pad2, pct, shortDate } from '../lib/format';
import {
  BlueprintLoader,
  Button,
  Card,
  Dial,
  Drawer,
  EmptyState,
  ErrorState,
  Icon,
  LevelGlyph,
  Meter,
  PageHeader,
  QuoteBlock,
  Skeleton,
  Stat,
  Tabs,
  ease,
  levelLabel,
  useNarrow,
  useToast,
} from '../ui';
import { Constellation } from './gap/Constellation';
import './Gap.css';

type View = 'map' | 'list';
type SortKey = 'priority' | 'demand' | 'gap' | 'name';

export function Gap() {
  const gap = useGap();
  const plan = usePlan();
  const postings = usePostings();
  const { data: state } = useAppState();
  const narrow = useNarrow();
  const [view, setView] = useState<View | undefined>();
  const [params, setParams] = useSearchParams();
  const linked = params.get('skill') ?? undefined;
  const [openId, setOpenId] = useState<string | undefined>(linked);
  const [building, setBuilding] = useState(false);
  const toast = useToast();
  const shownView: View = view ?? (narrow ? 'list' : 'map');

  const data = gap.data;
  const top5 = useMemo(
    () => (data ? [...data.skills].filter((s) => s.level !== 'strong' && s.status !== 'closed').sort((a, b) => b.priority - a.priority).slice(0, 5) : []),
    [data],
  );
  const ranks = useMemo(() => new Map(top5.map((s, i) => [s.id, i + 1])), [top5]);
  const open = data?.skills.find((s) => s.id === openId);

  // /gap?skill=<id>, from the Portfolio and Plan chips, opens that skill's evidence drawer.
  useEffect(() => {
    if (linked) setOpenId(linked);
  }, [linked]);

  const closeDrawer = () => {
    setOpenId(undefined);
    if (!linked) return;
    const next = new URLSearchParams(params);
    next.delete('skill');
    setParams(next, { replace: true });
  };

  const build = async () => {
    setBuilding(true);
    try {
      const g = await actions.buildGap();
      toast({ title: 'Gap map rebuilt', body: `Readiness ${g.readiness} of 100.`, tone: 'success' });
    } catch (e) {
      toast({ title: 'Could not build the gap map', body: (e as Error).message, tone: 'error' });
    } finally {
      setBuilding(false);
    }
  };

  const target = state?.goal?.targetRole;

  return (
    <div className="gap">
      <PageHeader
        index="02"
        section="Gap map"
        title="Where you stand"
        purpose={
          target
            ? `Every skill the ${target} postings ask for. Size is how often it comes up; fill is how much of it your résumé shows.`
            : 'Every skill the postings ask for. Size is how often it comes up; fill is how much of it your résumé shows.'
        }
        actions={
          data ? (
            <Button variant="quiet" iconLeft="refresh" onClick={build} loading={building}>
              Rebuild
            </Button>
          ) : undefined
        }
      />

      {building ? (
        <Card pad="lg">
          <BuildingLoader />
        </Card>
      ) : gap.error && !data ? (
        <ErrorState title="Could not load the gap map" message={gap.error.message} onRetry={() => gap.refetch().catch(() => undefined)} />
      ) : gap.loading ? (
        <GapSkeleton />
      ) : !data ? (
        <EmptyState
          eyebrow="No gap map yet"
          title="Read the market first"
          body={
            postings.data?.length
              ? `There are ${postings.data.length} postings ready. Building the map compares each one with your résumé.`
              : 'Tack compares about 40 postings with your résumé and draws the map here.'
          }
          action={
            postings.data?.length ? (
              <Button variant="primary" icon="arrow-right" onClick={build}>
                Build the gap map
              </Button>
            ) : (
              <Button variant="primary" icon="arrow-right" to="/">
                Go to Start
              </Button>
            )
          }
        />
      ) : (
        <>
          <Readiness gap={data} />
          <TopFive skills={top5} onOpen={setOpenId} />

          <div className="gap__viewbar">
            <div className="gap__legend" aria-label="Legend">
              {(['strong', 'partial', 'missing'] as Level[]).map((l) => (
                <span key={l} className="legend__item">
                  <LevelGlyph level={l} size={12} />
                  {levelLabel[l]}
                  <span className="t-num legend__n">{data.skills.filter((s) => s.level === l).length}</span>
                </span>
              ))}
              <span className="legend__item legend__size">
                <svg width="30" height="14" viewBox="0 0 30 14" aria-hidden="true">
                  <circle cx="4" cy="7" r="3" />
                  <circle cx="20" cy="7" r="6.5" />
                </svg>
                Size is demand
              </span>
            </div>
            <Tabs
              aria-label="View"
              items={[
                { id: 'map', label: 'Constellation', icon: 'constellation' },
                { id: 'list', label: 'List', icon: 'list' },
              ]}
              value={shownView}
              onChange={(v) => setView(v)}
            />
          </div>

          {shownView === 'map' ? (
            <Card pad="none" className="gap__map">
              <Constellation skills={data.skills} ranks={ranks} selected={openId} onSelect={setOpenId} />
            </Card>
          ) : (
            <SkillList skills={data.skills} ranks={ranks} onOpen={setOpenId} />
          )}

          <p className="gap__foot t-micro">
            Built {shortDate(data.generatedAt)} from {data.postingCount} {state?.mode === 'live' || (state?.profile && state.profile.source !== 'demo') ? 'live' : 'sample'} postings. {data.market.salaryNote}
          </p>
        </>
      )}

      <EvidenceDrawer skill={open} rank={open ? ranks.get(open.id) : undefined} plan={plan.data ?? undefined} onClose={closeDrawer} />
    </div>
  );
}

function BuildingLoader() {
  return (
    <BlueprintLoader label="Rebuilding the gap map" detail="Extracting skills from each posting, then scoring them against your résumé" stages={['Extract skills', 'Normalise', 'Score']} stage={0} height={260} />
  );
}

function Readiness({ gap }: { gap: GapMap }) {
  const narrow = useNarrow();
  const counts = { strong: 0, partial: 0, missing: 0 } as Record<Level, number>;
  gap.skills.forEach((s) => counts[s.level]++);
  return (
    <Card pad="lg" className="readiness" settle>
      <div className="readiness__dial">
        <Dial value={gap.readiness} size={narrow ? 200 : 232} caption="weighted by demand" />
      </div>
      <div className="readiness__body">
        <span className="t-label">Summary</span>
        <motion.p className="readiness__summary" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1, ease, delay: 0.3 }}>
          {gap.summary}
        </motion.p>
        <div className="readiness__stats">
          <Stat size="sm" label="Postings" value={gap.postingCount} />
          <Stat size="sm" label="Skills" value={gap.skills.length} />
          <Stat size="sm" label="Strong" value={counts.strong} />
          <Stat size="sm" label="Partial" value={counts.partial} />
          <Stat size="sm" label="Missing" value={<span className="t-accent">{counts.missing}</span>} />
        </div>
      </div>
    </Card>
  );
}

function TopFive({ skills, onOpen }: { skills: GapSkill[]; onOpen: (id: string) => void }) {
  if (!skills.length) return null;
  return (
    <section className="top5" aria-labelledby="top5-title">
      <div className="top5__head">
        <span className="t-label" id="top5-title">
          Top five to close
        </span>
        <span className="t-micro">Ranked by priority: demand times the gap</span>
      </div>
      <div className="top5__row">
        {skills.map((s, i) => (
          <motion.button
            key={s.id}
            type="button"
            className="close-card"
            onClick={() => onOpen(s.id)}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease, delay: 0.15 + i * 0.06 }}
          >
            <span className="close-card__top">
              <span className="close-card__rank t-num">{pad2(i + 1)}</span>
              <span className="close-card__prio t-num" title="Priority">
                {s.priority}
              </span>
            </span>
            <span className="close-card__name">{s.name}</span>
            <span className="close-card__level">
              <LevelGlyph level={s.level} />
              {levelLabel[s.level]}
              <span className="t-faint">·</span>
              <span className="t-num">{pct(s.demand)}</span>
            </span>
            <Meter value={s.have} max={5} marker={s.need} size="xs" aria-label={`Have ${s.have} of 5, need ${s.need}`} />
            <span className="close-card__hn t-micro">
              Have {s.have} · need {s.need}
            </span>
          </motion.button>
        ))}
      </div>
    </section>
  );
}

function SkillList({ skills, ranks, onOpen }: { skills: GapSkill[]; ranks: Map<string, number>; onOpen: (id: string) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'priority', dir: -1 });
  const rows = useMemo(() => {
    const val = (s: GapSkill) =>
      sort.key === 'priority' ? s.priority : sort.key === 'demand' ? s.demand : sort.key === 'gap' ? s.need - s.have : s.name.toLowerCase();
    return [...skills].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [skills, sort]);

  const head = (key: SortKey, label: string, cls?: string) => {
    const on = sort.key === key;
    return (
      <th className={cls} aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button
          type="button"
          className={['th-btn', on && 'is-on'].filter(Boolean).join(' ')}
          onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1 }))}
        >
          {label}
          <Icon name={on && sort.dir === 1 ? 'chevron-up' : 'chevron-down'} size={12} />
        </button>
      </th>
    );
  };

  return (
    <div className="skill-list">
      <div className="skill-list__sort-mobile">
        <Tabs
          size="sm"
          aria-label="Sort by"
          items={[
            { id: 'priority', label: 'Priority' },
            { id: 'demand', label: 'Demand' },
            { id: 'gap', label: 'Gap' },
            { id: 'name', label: 'Name' },
          ]}
          value={sort.key}
          onChange={(key) => setSort({ key, dir: key === 'name' ? 1 : -1 })}
        />
      </div>
      <table className="skill-table">
        <thead>
          <tr>
            {head('name', 'Skill')}
            {head('demand', 'Demand', 'col-demand')}
            <th className="col-must">
              <span className="th-plain">Must</span>
            </th>
            {head('gap', 'Have / need', 'col-hn')}
            {head('priority', 'Priority', 'col-prio')}
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => (
            <motion.tr
              key={s.id}
              onClick={() => onOpen(s.id)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onOpen(s.id);
              }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, ease, delay: Math.min(i, 20) * 0.02 }}
            >
              <td>
                <span className="cell-skill">
                  <LevelGlyph level={s.level} size={12} />
                  <span className="cell-skill__text">
                    <span className="cell-skill__name">
                      {s.name}
                      {ranks.has(s.id) && <span className="rank-tag t-num">{ranks.get(s.id)}</span>}
                    </span>
                    <span className="cell-skill__cat">{s.category}</span>
                  </span>
                </span>
              </td>
              <td className="col-demand">
                <span className="cell-demand">
                  <Meter value={s.demand * 100} size="xs" />
                  <span className="t-num">{pct(s.demand)}</span>
                </span>
              </td>
              <td className="col-must t-num">{pct(s.mustShare)}</td>
              <td className="col-hn">
                <span className="cell-hn">
                  <Meter value={s.have} max={5} marker={s.need} size="xs" tone={s.level === 'missing' ? 'accent' : 'paper'} />
                  <span className="t-num">
                    {s.have}
                    <span className="t-faint">/</span>
                    {s.need}
                  </span>
                </span>
              </td>
              <td className="col-prio t-num">
                <span className={s.priority >= 20 ? 't-accent' : ''}>{s.priority}</span>
              </td>
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GapSkeleton() {
  return (
    <div className="gap__skeleton" aria-busy="true">
      <Card pad="lg" className="readiness">
        <Skeleton width={232} height={232} radius="50%" />
        <div className="readiness__body">
          <Skeleton width={90} height={10} />
          <Skeleton lines={4} height={16} />
        </div>
      </Card>
      <div className="top5__row">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} height={150} radius={14} />
        ))}
      </div>
      <Skeleton height={520} radius={16} />
    </div>
  );
}

function weeksFor(plan: Plan | undefined, id: string) {
  return plan?.weeks.filter((w) => w.skillIds.includes(id) || w.tasks.some((t) => t.skillIds.includes(id))) ?? [];
}

function EvidenceDrawer({ skill, rank, plan, onClose }: { skill?: GapSkill; rank?: number; plan?: Plan; onClose: () => void }) {
  const last = useRef<GapSkill | undefined>(skill);
  if (skill) last.current = skill;
  const s = skill ?? last.current;
  const navigate = useNavigate();
  const weeks = s ? weeksFor(plan, s.id) : [];

  return (
    <Drawer
      open={!!skill}
      onClose={onClose}
      width={820}
      eyebrow={
        s ? (
          <span className="ev__eyebrow">
            {s.category}
            {rank ? <span className="t-accent">No. {rank} to close</span> : null}
          </span>
        ) : undefined
      }
      title={
        s ? (
          <span className="ev__title">
            <LevelGlyph level={s.level} size={16} />
            {s.name}
          </span>
        ) : (
          ''
        )
      }
    >
      {s && (
        <div className="ev">
          <div className="ev__stats">
            <Stat size="sm" label="Demand" value={pct(s.demand)} note="of postings ask for it" />
            <Stat size="sm" label="Must" value={pct(s.mustShare)} note="of those list it as a must" />
            <Stat size="sm" label="Priority" value={<span className={s.priority >= 20 ? 't-accent' : ''}>{s.priority}</span>} unit="/100" note="demand times the gap" />
            <Stat size="sm" label="Status" value={<span className="ev__status">{s.status === 'open' ? 'Open' : s.status === 'learning' ? 'Learning' : 'Closed'}</span>} note={levelLabel[s.level]} />
          </div>

          <div className="ev__hn">
            <div className="ev__hn-head">
              <span className="t-label">Need vs have</span>
              <span className="t-num ev__hn-n">
                have {s.have} <span className="t-faint">/</span> need {s.need}
              </span>
            </div>
            <div className="ev__scale">
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <span key={n} className="t-num">
                  {n}
                </span>
              ))}
            </div>
            <Meter value={s.have} max={5} marker={s.need} size="md" tone={s.level === 'missing' ? 'accent' : 'paper'} aria-label={`Have ${s.have}, need ${s.need}`} />
          </div>

          {s.bridge && (
            <div className="ev__bridge">
              <span className="t-label">
                Bridge from <span className="ev__bridge-from">{s.bridge.from}</span>
              </span>
              <p>{s.bridge.note}</p>
            </div>
          )}

          <div className="ev__cols">
            <div className="ev__col">
              <span className="t-label ev__col-head">
                From your résumé <span className="t-num t-faint">{s.evidence.resume.length}</span>
              </span>
              {s.evidence.resume.length ? (
                s.evidence.resume.map((q, i) => <QuoteBlock key={i} quote={q} source="Résumé" size="sm" />)
              ) : (
                <p className="ev__none">No line in the résumé shows this yet. That is what makes it a gap.</p>
              )}
            </div>
            <div className="ev__col">
              <span className="t-label ev__col-head">
                From the postings <span className="t-num t-faint">{s.evidence.postings.length}</span>
              </span>
              {s.evidence.postings.map((q, i) => (
                <QuoteBlock
                  key={`${q.postingId}-${i}`}
                  quote={q.quote}
                  source={q.company}
                  size="sm"
                  tone={s.level === 'missing' ? 'accent' : 'paper'}
                  detail="open posting"
                  onClick={() => navigate(`/market?posting=${encodeURIComponent(q.postingId)}`)}
                />
              ))}
            </div>
          </div>

          <div className="ev__plan">
            <span className="t-label">In the plan</span>
            {!plan ? (
              <p className="ev__none">No plan yet. The plan places each open skill into a week.</p>
            ) : weeks.length ? (
              <ul>
                {weeks.map((w) => (
                  <li key={w.index}>
                    <span className="t-num ev__week">Week {pad2(w.index)}</span>
                    <span className="ev__theme">{w.theme}</span>
                    <span className="t-micro">{shortDate(w.startDate)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ev__none">{s.level === 'strong' ? 'Already strong, so it has no week of its own.' : 'Not scheduled yet. A replan will pick it up.'}</p>
            )}
            {plan && (
              <Button variant="quiet" size="sm" icon="arrow-right" to="/plan">
                Open the plan
              </Button>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

