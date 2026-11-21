import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { motion } from 'motion/react';
import { useLatestTrace } from '../api/events';
import { actions, keys, useGap, usePlan, usePortfolio } from '../api/hooks';
import { setQueryData } from '../api/query';
import type { GapMap, GapSkill, Plan, PortfolioProject } from '../api/types';
import { pad2 } from '../lib/format';
import {
  BlueprintLoader,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LevelGlyph,
  Modal,
  PageHeader,
  QuoteBlock,
  Skeleton,
  Stat,
  Tabs,
  ease,
  useToast,
} from '../ui';
import { skillNamer, weekOfToday } from './plan/weeks';
import './Portfolio.css';

type Status = PortfolioProject['status'];

const STATUS_ITEMS: { id: Status; label: string }[] = [
  { id: 'idea', label: 'Idea' },
  { id: 'building', label: 'Building' },
  { id: 'shipped', label: 'Shipped' },
];

// Ticked deliverables live on the project; a shipped project with none recorded counts as all done.
const doneOf = (p: PortfolioProject) => p.deliverablesDone ?? (p.status === 'shipped' ? p.deliverables : []);

const openSkills = (gap: GapMap) =>
  gap.skills.filter((s) => s.level !== 'strong' && s.status !== 'closed').sort((a, b) => b.priority - a.priority);

export function Portfolio() {
  const projects = usePortfolio();
  const gap = useGap();
  const plan = usePlan();
  const toast = useToast();
  const [building, setBuilding] = useState(false);
  const [since, setSince] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const name = useMemo(() => skillNamer(gap.data), [gap.data]);
  const list = projects.data ?? [];

  const build = async () => {
    setConfirm(false);
    setSince(Date.now());
    setBuilding(true);
    try {
      const out = await actions.buildPortfolio();
      toast({ title: `${out.length} projects drafted`, body: 'Each one closes at least two open skills and sits in your plan weeks.', tone: 'success' });
    } catch (e) {
      toast({ title: "Couldn't create projects", body: (e as Error).message, tone: 'error' });
    } finally {
      setBuilding(false);
    }
  };

  const setStatus = async (p: PortfolioProject, status: Status) => {
    if (p.status === status) return;
    const was = p.status;
    const put = (s: Status) => setQueryData<PortfolioProject[]>(keys.portfolio, (all) => (all ?? []).map((x) => (x.id === p.id ? { ...x, status: s } : x)));
    put(status);
    try {
      await actions.setProjectStatus(p.id, status);
      if (status === 'shipped') toast({ title: `${p.title} shipped`, body: 'Link it from your résumé and case study.', tone: 'success' });
    } catch (e) {
      put(was);
      toast({ title: "Couldn't update the status", body: (e as Error).message, tone: 'error' });
    }
  };

  const toggle = async (p: PortfolioProject, i: number) => {
    const was = p.deliverablesDone;
    const base = doneOf(p);
    const item = p.deliverables[i];
    const next = p.deliverables.filter((d) => (d === item ? !base.includes(d) : base.includes(d)));
    const put = (done: string[] | undefined) =>
      setQueryData<PortfolioProject[]>(keys.portfolio, (all) => (all ?? []).map((x) => (x.id === p.id ? { ...x, deliverablesDone: done } : x)));
    put(next);
    try {
      await actions.setDeliverables(p.id, next);
    } catch (e) {
      put(was);
      toast({ title: "Couldn't save the checkmark", body: (e as Error).message, tone: 'error' });
    }
  };

  return (
    <div className="folio">
      <PageHeader
        index="04"
        section="Portfolio"
        title="Work you can show"
        purpose="Three projects that each cover at least two gaps, tied to your weekly plan and real job posts."
        actions={
          list.length && !building ? (
            <Button variant="quiet" iconLeft="refresh" onClick={() => setConfirm(true)}>
              Suggest again
            </Button>
          ) : undefined
        }
      />

      {building ? (
        <Card pad="lg">
          <BuildLoader since={since} />
        </Card>
      ) : projects.error && !projects.data ? (
        <ErrorState title="Couldn't load the portfolio" message={projects.error.message} onRetry={() => projects.refetch().catch(() => undefined)} />
      ) : projects.loading ? (
        <FolioSkeleton />
      ) : !list.length ? (
        <EmptyFolio gap={gap.data ?? undefined} onBuild={build} />
      ) : (
        <>
          {gap.data && <Coverage projects={list} gap={gap.data} name={name} />}
          <div className="projects">
            {list.map((p, i) => (
              <ProjectCard
                key={p.id}
                project={p}
                index={i}
                count={list.length}
                gap={gap.data ?? undefined}
                plan={plan.data ?? undefined}
                name={name}
                checked={p.deliverables.flatMap((d, j) => (doneOf(p).includes(d) ? [j] : []))}
                onToggle={(j) => void toggle(p, j)}
                onStatus={(s) => setStatus(p, s)}
              />
            ))}
          </div>
        </>
      )}

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        eyebrow="Suggest again"
        title="Replace these three projects?"
        footer={
          <>
            <Button variant="quiet" onClick={() => setConfirm(false)}>
              Keep these
            </Button>
            <Button variant="primary" onClick={build}>
              Create new projects
            </Button>
          </>
        }
      >
        <p className="t-mute">Tack creates three new projects from your open skills. Current progress and checked items will reset.</p>
      </Modal>
    </div>
  );
}

/* coverage strip */

function SkillLink({ skill, label, marks, uncovered }: { skill?: GapSkill; label: string; marks?: number[]; uncovered?: boolean }) {
  return (
    <Link to={`/gap?skill=${encodeURIComponent(skill?.id ?? label)}`} className={['chip chip--sm skill-link', uncovered && 'is-uncovered'].filter(Boolean).join(' ')}>
      {skill && <LevelGlyph level={skill.level} size={9} />}
      <span className="chip__text">{label}</span>
      {marks && marks.length > 0 && <span className="skill-link__marks t-num">{marks.map(pad2).join(' ')}</span>}
    </Link>
  );
}

function Coverage({ projects, gap, name }: { projects: PortfolioProject[]; gap: GapMap; name: (id: string) => string }) {
  const open = openSkills(gap);
  const by = new Map<string, number[]>();
  projects.forEach((p, i) => p.skillIds.forEach((id) => by.set(id, [...(by.get(id) ?? []), i + 1])));
  const covered = open.filter((s) => by.has(s.id));
  const left = open.filter((s) => !by.has(s.id));
  const weight = open.reduce((a, s) => a + Math.max(1, s.priority), 0) || 1;
  const coveredWeight = covered.reduce((a, s) => a + Math.max(1, s.priority), 0);

  return (
    <Card pad="md" className="cover" settle>
      <div className="cover__stat">
        <Stat label="Coverage" value={covered.length} unit={`of ${open.length}`} note="open gap skills these projects close" />
        <span className="t-micro cover__weight">{Math.round((coveredWeight / weight) * 100)}% of total priority</span>
      </div>
      <div className="cover__main">
        <div className="cover__bar" role="img" aria-label={`${covered.length} of ${open.length} missing skills covered`}>
          {open.map((s, i) => (
            <motion.span
              key={s.id}
              className={by.has(s.id) ? 'is-on' : undefined}
              style={{ flexGrow: Math.max(1, s.priority) } as CSSProperties}
              title={`${s.name}: priority ${s.priority}${by.has(s.id) ? '' : ', not covered'}`}
              initial={{ scaleY: 0 }}
              animate={{ scaleY: 1 }}
              transition={{ duration: 0.7, ease, delay: 0.15 + i * 0.03 }}
            />
          ))}
        </div>
        <span className="t-micro cover__caption">Open skills by priority, highest first. Filled ones are covered.</span>
        <div className="cover__groups">
          <div className="cover__group">
            <span className="t-label">
              Covered <span className="t-num t-faint">{covered.length}</span>
            </span>
            <div className="cover__chips">
              {covered.map((s) => (
                <SkillLink key={s.id} skill={s} label={s.name} marks={by.get(s.id)} />
              ))}
            </div>
          </div>
          <div className="cover__group">
            <span className="t-label">
              Left uncovered <span className="t-num t-faint">{left.length}</span>
            </span>
            {left.length ? (
              <div className="cover__chips">
                {left.map((s) => (
                  <SkillLink key={s.id} skill={s} label={name(s.id)} uncovered />
                ))}
              </div>
            ) : (
              <p className="cover__none">Every missing skill has a project.</p>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

/* project card */

function ProjectCard({
  project: p,
  index,
  count,
  gap,
  plan,
  name,
  checked,
  onToggle,
  onStatus,
}: {
  project: PortfolioProject;
  index: number;
  count: number;
  gap?: GapMap;
  plan?: Plan;
  name: (id: string) => string;
  checked: number[];
  onToggle: (i: number) => void;
  onStatus: (s: Status) => void;
}) {
  const skills = new Map((gap?.skills ?? []).map((s) => [s.id, s]));
  return (
    <motion.article
      className={`project is-${p.status}`}
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.9, ease, delay: 0.12 + index * 0.08 }}
      aria-labelledby={`project-${p.id}`}
    >
      <header className="project__head">
        <span className="t-label project__no">
          <span className="t-accent">{pad2(index + 1)}</span>
          <span className="t-faint">/</span>
          {pad2(count)}
        </span>
        <Tabs size="sm" aria-label={`Status of ${p.title}`} items={STATUS_ITEMS} value={p.status} onChange={onStatus} />
      </header>

      <div className="project__grid">
        <div className="project__main">
          <h2 className="project__title" id={`project-${p.id}`}>
            {p.title}
          </h2>
          <p className="project__pitch">{p.pitch}</p>

          <div className="project__block">
            <span className="t-label">Closes</span>
            <div className="project__skills">
              {p.skillIds.map((id) => (
                <SkillLink key={id} skill={skills.get(id)} label={name(id)} />
              ))}
            </div>
          </div>

          <div className="project__block">
            <span className="t-label">The brief</span>
            <p className="project__brief">{p.brief}</p>
          </div>

          <div className="project__reviewer">
            <span className="t-label">What reviewers will see</span>
            <p>{p.reviewerSees}</p>
          </div>
        </div>

        <aside className="project__side">
          <Milestones project={p} plan={plan} />
          <Deliverables items={p.deliverables} checked={checked} onToggle={onToggle} />
        </aside>
      </div>

      {p.postingQuotes.length > 0 && (
        <footer className="project__quotes">
          <span className="t-label">
            Why this matters <span className="t-num t-faint">{p.postingQuotes.length}</span>
          </span>
          <div className="project__quote-row">
            {p.postingQuotes.map((q, i) => (
              <QuoteBlock key={`${q.company}-${i}`} quote={q.quote} source={q.company} detail="posting" size="sm" />
            ))}
          </div>
        </footer>
      )}
    </motion.article>
  );
}

function Milestones({ project, plan }: { project: PortfolioProject; plan?: Plan }) {
  const max = Math.max(0, ...project.milestones.map((m) => m.week));
  const W = Math.max(plan?.weeks.length ?? 12, max, 1);
  const raw = plan ? weekOfToday(plan) : 0;
  const ms = [...project.milestones].sort((a, b) => a.week - b.week);
  const x = (week: number) => `${((week - 0.5) / W) * 100}%`;
  const first = ms[0]?.week;
  const last = ms[ms.length - 1]?.week;
  const when = (week: number) => {
    if (!raw) return '';
    if (week < raw) return 'Past';
    if (week === raw) return 'This week';
    const n = week - raw;
    return `In ${n} week${n > 1 ? 's' : ''}`;
  };

  return (
    <div className="mtl">
      <div className="mtl__head">
        <span className="t-label">Milestones</span>
        <span className="t-micro">In your weekly plan</span>
      </div>
      <div className="mtl__chart" aria-hidden="true">
        <div className="mtl__track">
          {Array.from({ length: W }, (_, i) => (
            <span key={i} className={['mtl__tick', raw > W || i + 1 < raw ? 'is-past' : ''].filter(Boolean).join(' ')} style={{ left: x(i + 1) }} />
          ))}
          {first !== undefined && last !== undefined && (
            <motion.span
              className="mtl__span"
              style={{ left: x(first), width: `${((last - first) / W) * 100}%` }}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 1, ease, delay: 0.3 }}
            />
          )}
          {raw >= 1 && raw <= W && <span className="mtl__now" style={{ left: x(raw) }} />}
          {ms.map((m, i) => (
            <span
              key={`${m.week}-${i}`}
              className={['mtl__dot', raw && m.week < raw ? 'is-past' : '', m.week === raw ? 'is-now' : ''].filter(Boolean).join(' ')}
              style={{ left: x(m.week) }}
            />
          ))}
        </div>
        <div className="mtl__weeks">
          {Array.from({ length: W }, (_, i) => (
            <span key={i} className={['t-num', ms.some((m) => m.week === i + 1) && 'is-on', i + 1 === raw && 'is-now'].filter(Boolean).join(' ')} style={{ left: x(i + 1) }}>
              {i + 1}
            </span>
          ))}
        </div>
      </div>
      <ol className="mtl__list">
        {ms.map((m, i) => (
          <li key={`${m.title}-${i}`} className={raw && m.week < raw ? 'is-past' : undefined}>
            <span className="t-num mtl__w">W{pad2(m.week)}</span>
            <span className="mtl__title">{m.title}</span>
            <span className={['t-micro mtl__when', m.week === raw && 't-accent'].filter(Boolean).join(' ')}>{when(m.week)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Deliverables({ items, checked, onToggle }: { items: string[]; checked: number[]; onToggle: (i: number) => void }) {
  const done = items.filter((_, i) => checked.includes(i)).length;
  return (
    <div className="dlv">
      <div className="mtl__head">
        <span className="t-label">Deliverables</span>
        <span className="t-num dlv__n">
          {done}
          <span className="t-faint">/{items.length}</span>
        </span>
      </div>
      <ul className="dlv__list">
        {items.map((d, i) => {
          const on = checked.includes(i);
          return (
            <li key={`${d}-${i}`}>
              <button type="button" role="checkbox" aria-checked={on} className={['dlv__item', on && 'is-on'].filter(Boolean).join(' ')} onClick={() => onToggle(i)}>
                <span className="dlv__box" aria-hidden="true">
                  <svg viewBox="0 0 16 16">
                    <motion.path
                      d="m4 8.4 2.6 2.6 5.4-6"
                      fill="none"
                      initial={false}
                      animate={{ pathLength: on ? 1 : 0, opacity: on ? 1 : 0 }}
                      transition={{ duration: 0.4, ease }}
                    />
                  </svg>
                </span>
                <span className="dlv__text">{d}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* states */

function BuildLoader({ since }: { since: number }) {
  const latest = useLatestTrace(since);
  const text = latest ? `${latest.step} ${latest.detail}` : '';
  const stage = /link|quote|week/i.test(text) ? 2 : /llm|word|brief/i.test(text) ? 1 : 0;
  return (
    <BlueprintLoader
      label="Creating portfolio projects"
      detail={latest ? `${latest.step} · ${latest.detail}` : 'Grouping missing skills into projects reviewers can see'}
      stages={['Pick the open skills', 'Write the briefs', 'Match to weeks and job posts']}
      stage={stage}
      height={260}
    />
  );
}

function EmptyFolio({ gap, onBuild }: { gap?: GapMap; onBuild: () => void }) {
  if (!gap) {
    return (
      <EmptyState
        eyebrow="No projects yet"
        title="Map the gap first"
        body="Projects come from skills in job posts that aren't on your résumé yet."
        action={
          <Button variant="primary" icon="arrow-right" to="/gap">
            Open the gap map
          </Button>
        }
      />
    );
  }
  const n = openSkills(gap).length;
  return (
    <EmptyState
      eyebrow="No projects yet"
      title="Three projects that show your gaps are closed"
      body={`Tack groups the ${n} open skills into three projects, each covering at least two, with a brief, weekly milestones, and matching job posts.`}
      action={
        <Button variant="primary" icon="arrow-right" onClick={onBuild}>
          Suggest projects
        </Button>
      }
    />
  );
}

function FolioSkeleton() {
  return (
    <div className="folio-skeleton" aria-busy="true">
      <Skeleton height={168} radius={16} />
      {[0, 1].map((i) => (
        <div key={i} className="folio-skeleton__card">
          <div className="folio-skeleton__main">
            <Skeleton width={70} height={10} />
            <Skeleton width="70%" height={34} />
            <Skeleton lines={2} height={16} />
            <Skeleton lines={3} height={12} />
          </div>
          <div className="folio-skeleton__side">
            <Skeleton height={60} radius={10} />
            <Skeleton lines={4} height={12} />
          </div>
        </div>
      ))}
    </div>
  );
}
