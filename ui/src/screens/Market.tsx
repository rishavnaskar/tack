import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { motion } from 'motion/react';
import { actions, useAppState, usePostings } from '../api/hooks';
import type { Posting } from '../api/types';
import { ago, countBy, hostOf, median, sizeLabel } from '../lib/format';
import { Bar, Button, Card, Chip, Drawer, EmptyState, ErrorState, Icon, Meter, PageHeader, Skeleton, Stat, Tabs, ease, useToast } from '../ui';
import './Market.css';

type Size = 'all' | 'startup' | 'scaleup' | 'enterprise';
type Fit = 'all' | 'high' | 'mid' | 'low';
type Source = 'all' | 'live' | 'sample';
type Sort = 'fit' | 'new';

const FIT_BANDS: Record<Exclude<Fit, 'all'>, [number, number, string]> = {
  high: [70, 101, '70 and up'],
  mid: [50, 70, '50 to 69'],
  low: [0, 50, 'Under 50'],
};

const SENIORITY_ORDER = ['Intern', 'Associate', 'Junior', 'Mid', 'Senior', 'Staff', 'Lead', 'Principal', 'Director'];
const sen = (p: Posting) => (p.seniority ? p.seniority[0].toUpperCase() + p.seniority.slice(1) : undefined);
const byLevel = (a: string, b: string) => {
  const ia = SENIORITY_ORDER.indexOf(a);
  const ib = SENIORITY_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
};

export function Market() {
  const postings = usePostings();
  const { data: state } = useAppState();
  const [params, setParams] = useSearchParams();
  const [size, setSize] = useState<Size>('all');
  const [seniority, setSeniority] = useState('all');
  const [fit, setFit] = useState<Fit>('all');
  const [source, setSource] = useState<Source>('all');
  const [sort, setSort] = useState<Sort>('fit');
  const [harvesting, setHarvesting] = useState(false);
  const [harvestKey, setHarvestKey] = useState(0);
  const toast = useToast();

  const all = postings.data ?? [];
  const openId = params.get('posting');
  const open = all.find((p) => p.id === openId);

  const list = useMemo(() => {
    const out = all.filter((p) => {
      if (size !== 'all' && p.companySize !== size) return false;
      if (seniority !== 'all' && sen(p) !== seniority) return false;
      if (fit !== 'all') {
        const [lo, hi] = FIT_BANDS[fit];
        const f = p.fit ?? -1;
        if (f < lo || f >= hi) return false;
      }
      if (source === 'live' && !p.live) return false;
      if (source === 'sample' && p.live) return false;
      return true;
    });
    return out.sort((a, b) =>
      sort === 'fit' ? (b.fit ?? 0) - (a.fit ?? 0) : Date.parse(b.postedAt ?? b.harvestedAt) - Date.parse(a.postedAt ?? a.harvestedAt),
    );
  }, [all, size, seniority, fit, source, sort]);

  const seniorities = useMemo(() => [...new Set(all.map(sen).filter((s): s is string => !!s))].sort(byLevel), [all]);
  const filtered = size !== 'all' || seniority !== 'all' || fit !== 'all' || source !== 'all';
  const clear = () => {
    setSize('all');
    setSeniority('all');
    setFit('all');
    setSource('all');
  };

  const harvest = async () => {
    setHarvesting(true);
    try {
      const res = await actions.harvest(40);
      setHarvestKey((k) => k + 1);
      toast({ title: `${res.postings.length} postings read`, body: res.live ? 'Read live through the engine.' : 'From the bundled sample; the engine is off.', tone: 'success' });
    } catch (e) {
      toast({ title: 'Could not read postings', body: (e as Error).message, tone: 'error' });
    } finally {
      setHarvesting(false);
    }
  };

  const setOpen = (id?: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('posting', id);
    else next.delete('posting');
    setParams(next, { replace: true });
  };

  const goal = state?.goal;
  const anyLive = all.some((p) => p.live);
  const purpose = goal
    ? `Every posting Tack read for ${goal.targetRole}${goal.location ? ` in ${goal.location}` : ''}, with the skills each one asks for and how well you fit.`
    : 'Every posting Tack read, with the skills each one asks for and how well you fit.';

  return (
    <div className="market">
      <PageHeader
        index="01"
        section="Market"
        title="The market, read closely"
        purpose={purpose}
        actions={
          all.length > 0 ? (
            <>
              <Chip tone={anyLive ? 'olive' : 'mute'} mono size="sm">
                {anyLive ? 'Live postings' : 'Sample postings'}
              </Chip>
              <Button variant="ghost" iconLeft="refresh" onClick={harvest} loading={harvesting} disabled={!state?.profile}>
                Read again
              </Button>
            </>
          ) : undefined
        }
      />

      {postings.error && !postings.data ? (
        <ErrorState title="Could not load postings" message={postings.error.message} onRetry={() => postings.refetch().catch(() => undefined)} />
      ) : postings.loading || harvesting ? (
        <MarketLoading harvesting={harvesting} />
      ) : all.length === 0 ? (
        <EmptyMarket canRun={!!state?.profile && !!goal?.targetRole} onRun={harvest} />
      ) : (
        <>
          <MarketStrip postings={all} />

          <div className="filters" role="group" aria-label="Filter postings">
            <FilterGroup label="Size" value={size} onChange={(v) => setSize(v as Size)} options={[['all', 'All'], ['startup', 'Startup'], ['scaleup', 'Scaleup'], ['enterprise', 'Enterprise']]} counts={(v) => all.filter((p) => p.companySize === v).length} />
            <FilterGroup label="Level" value={seniority} onChange={setSeniority} options={[['all', 'All'], ...seniorities.map((s): [string, string] => [s, s])]} counts={(v) => all.filter((p) => sen(p) === v).length} />
            <FilterGroup
              label="Fit"
              value={fit}
              onChange={(v) => setFit(v as Fit)}
              options={[['all', 'All'], ['high', '70+'], ['mid', '50–69'], ['low', 'Under 50']]}
              counts={(v) => {
                const [lo, hi] = FIT_BANDS[v as Exclude<Fit, 'all'>];
                return all.filter((p) => (p.fit ?? -1) >= lo && (p.fit ?? -1) < hi).length;
              }}
            />
            <FilterGroup label="Source" value={source} onChange={(v) => setSource(v as Source)} options={[['all', 'All'], ['live', 'Live'], ['sample', 'Sample']]} counts={(v) => all.filter((p) => (v === 'live' ? p.live : !p.live)).length} />
          </div>

          <div className="wall-head">
            <span className="t-label">
              Showing <span className="t-num wall-head__n">{list.length}</span> of {all.length}
              {filtered && (
                <button type="button" className="wall-head__clear" onClick={clear}>
                  Clear filters
                </button>
              )}
            </span>
            <Tabs
              size="sm"
              aria-label="Sort"
              items={[
                { id: 'fit', label: 'Best fit' },
                { id: 'new', label: 'Newest' },
              ]}
              value={sort}
              onChange={(v) => setSort(v as Sort)}
            />
          </div>

          {list.length === 0 ? (
            <EmptyState
              compact
              eyebrow="No matches"
              title="No postings match these filters"
              body="Loosen one of the filters above to see more."
              action={
                <Button variant="ghost" size="sm" onClick={clear}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <div className="wall" key={harvestKey}>
              {list.map((p, i) => (
                <PostingCard key={p.id} posting={p} index={i} onOpen={() => setOpen(p.id)} />
              ))}
            </div>
          )}
        </>
      )}

      <PostingDrawer posting={open} onClose={() => setOpen()} engineOn={!!state?.engine.available} />
    </div>
  );
}

function FilterGroup({
  label,
  value,
  onChange,
  options,
  counts,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  counts: (v: string) => number;
}) {
  return (
    <div className="filter">
      <span className="t-label filter__label">{label}</span>
      <div className="filter__chips">
        {options.map(([v, text]) => {
          const n = v === 'all' ? undefined : counts(v);
          return (
            <Chip key={v} size="sm" selected={value === v} onClick={() => onChange(v)} count={n} disabled={n === 0}>
              {text}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}

function MarketStrip({ postings }: { postings: Posting[] }) {
  const companies = countBy(postings, (p) => p.company).slice(0, 5);
  const locations = countBy(postings, (p) => p.location).slice(0, 5);
  const seniority = countBy(postings, sen).sort((a, b) => byLevel(a.name, b.name));
  const fits = postings.map((p) => p.fit).filter((f): f is number => f !== undefined);
  const strong = fits.filter((f) => f >= 70).length;
  const companyCount = new Set(postings.map((p) => p.company)).size;
  const pay = postings
    .map((p) => p.salary?.match(/(\d+)\D+(\d+)/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [Number(m[1]), Number(m[2])]);
  const payLine = pay.length ? (
    <>
      Pay listed on {pay.length} of {postings.length} ·{' '}
      <span className="nowrap">
        ₹{Math.min(...pay.map((x) => x[0]))}–{Math.max(...pay.map((x) => x[1]))} LPA
      </span>
    </>
  ) : (
    'No posting lists pay'
  );
  // when every company appears once, a size split says more than a top list
  const spread = (companies[0]?.count ?? 0) <= 1;
  const sizes = countBy(postings, (p) => (p.companySize ? sizeLabel[p.companySize] : undefined));
  const maxC = companies[0]?.count ?? 1;
  const maxL = locations[0]?.count ?? 1;

  return (
    <div className="strip">
      <Card pad="md" className="strip__stats" settle>
        <Stat label="Postings" value={postings.length} note={`from ${companyCount} companies`} />
        <Stat label="Median fit" value={fits.length ? median(fits) : '–'} unit="/100" note={`${strong} at 70 or above`} />
      </Card>
      <Card pad="md" label={spread ? 'Company size' : 'Top companies'} settle={0.06}>
        <div className="strip__bars">
          {(spread ? sizes : companies).map((c, i) => (
            <Bar key={c.name} label={c.name} value={c.count} max={spread ? (sizes[0]?.count ?? 1) : maxC} delay={0.1 + i * 0.05} />
          ))}
        </div>
      </Card>
      <Card pad="md" label="Locations" settle={0.12}>
        <div className="strip__bars">
          {locations.map((c, i) => (
            <Bar key={c.name} label={c.name} value={c.count} max={maxL} delay={0.15 + i * 0.05} />
          ))}
        </div>
      </Card>
      <Card pad="md" label="Seniority mix" settle={0.18}>
        <div className="mix">
          <div className="mix__bar" role="img" aria-label={seniority.map((s) => `${s.name} ${s.count}`).join(', ')}>
            {seniority.map((s, i) => (
              <motion.span
                key={s.name}
                className="mix__seg"
                style={{ flexGrow: s.count, opacity: 0.28 + (0.72 * (i + 1)) / seniority.length }}
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.9, ease, delay: 0.25 + i * 0.08 }}
              />
            ))}
          </div>
          <ul className="mix__legend">
            {seniority.map((s, i) => (
              <li key={s.name}>
                <span className="mix__swatch" style={{ opacity: 0.28 + (0.72 * (i + 1)) / seniority.length }} />
                <span className="mix__name">{s.name}</span>
                <span className="t-num mix__n">{s.count}</span>
              </li>
            ))}
          </ul>
          <p className="mix__pay t-micro">{payLine}</p>
        </div>
      </Card>
    </div>
  );
}

function PostingCard({ posting: p, index, onOpen }: { posting: Posting; index: number; onOpen: () => void }) {
  const delay = Math.min(index, 20) * 0.035;
  const top = [...(p.skills ?? [])].sort((a, b) => (a.importance === b.importance ? 0 : a.importance === 'must' ? -1 : 1));
  return (
    <motion.button
      type="button"
      className="win"
      onClick={onOpen}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease, delay }}
      aria-label={`${p.title} at ${p.company}, fit ${p.fit ?? 'unknown'}`}
    >
      <span className="win__bar">
        <span className="win__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="win__host">{hostOf(p.url)}</span>
        {p.live ? <span className="win__live" title="Read live" /> : <span className="win__sample">sample</span>}
      </span>
      <motion.span
        className="win__body"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, ease, delay: delay + 0.18 }}
      >
        <span className="win__title">{p.title}</span>
        <span className="win__company">
          {p.company}
          <span className="t-faint"> · </span>
          {p.location}
        </span>
        {p.fit !== undefined && (
          <span className="win__fit">
            <span className="t-label">Fit</span>
            <Meter value={p.fit} variant="segments" segments={12} size="sm" aria-label={`Fit ${p.fit}`} />
            <span className="t-num win__fit-n">{p.fit}</span>
          </span>
        )}
        <span className="win__skills">
          {top.slice(0, 3).map((s) => (
            <Chip key={s.skillId} size="sm" tone={s.importance === 'must' ? 'default' : 'mute'}>
              {s.name}
            </Chip>
          ))}
          {top.length > 3 && <span className="win__more t-num">+{top.length - 3}</span>}
        </span>
        <span className="win__foot t-micro">
          {p.companySize ? sizeLabel[p.companySize] : ''}
          {sen(p) ? ` · ${sen(p)}` : ''}
          {p.postedAt ? ` · ${ago(p.postedAt)}` : ''}
        </span>
      </motion.span>
    </motion.button>
  );
}

function MarketLoading({ harvesting }: { harvesting: boolean }) {
  return (
    <div aria-busy="true">
      <div className="strip">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={168} radius={16} />
        ))}
      </div>
      {harvesting && (
        <p className="market__reading t-mono">
          <span className="pulse-dot" /> Reading postings. Each window fills in as its skills are pulled out.
        </p>
      )}
      <div className="wall">
        {Array.from({ length: 12 }, (_, i) => (
          <motion.div
            key={i}
            className="win win--ghost"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, ease, delay: i * 0.05 }}
          >
            <span className="win__bar">
              <span className="win__dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <Skeleton width={110} height={8} />
            </span>
            <span className="win__body">
              <Skeleton width="78%" height={14} />
              <Skeleton width="52%" height={10} />
              <Skeleton height={4} style={{ marginTop: 14 }} />
              <span className="win__skills">
                <Skeleton width={74} height={22} radius={12} />
                <Skeleton width={58} height={22} radius={12} />
              </span>
            </span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function EmptyMarket({ canRun, onRun }: { canRun: boolean; onRun: () => void }) {
  return (
    <EmptyState
      eyebrow="No postings yet"
      title="Nothing read yet"
      body={
        canRun
          ? 'Tack will collect about 40 postings for your target role and pull out the skills each one asks for.'
          : 'Add a résumé and a target role on the start screen, then read the market.'
      }
      action={
        canRun ? (
          <Button variant="primary" icon="arrow-right" onClick={onRun}>
            Read the market
          </Button>
        ) : (
          <Button variant="primary" icon="arrow-right" to="/">
            Go to Start
          </Button>
        )
      }
    />
  );
}

/* drawer */

function PostingDrawer({ posting, onClose, engineOn }: { posting?: Posting; onClose: () => void; engineOn: boolean }) {
  const [focus, setFocus] = useState<string>();
  const [applying, setApplying] = useState(false);
  const toast = useToast();
  const last = useRef<Posting | undefined>(posting);
  if (posting) last.current = posting;
  const p = posting ?? last.current;

  useEffect(() => setFocus(undefined), [posting?.id]);

  const apply = async () => {
    if (!p) return;
    setApplying(true);
    try {
      const res = await actions.apply(p.id);
      toast({ title: res.started ? 'Handed to the engine' : 'Not sent', body: res.note, tone: res.started ? 'success' : 'default' });
    } catch (e) {
      toast({ title: 'Could not start the application', body: (e as Error).message, tone: 'error' });
    } finally {
      setApplying(false);
    }
  };

  const must = p?.skills?.filter((s) => s.importance === 'must') ?? [];
  const nice = p?.skills?.filter((s) => s.importance === 'nice') ?? [];

  return (
    <Drawer
      open={!!posting}
      onClose={onClose}
      width={680}
      eyebrow={p ? <span className="t-mono">{hostOf(p.url)}</span> : undefined}
      title={p?.title ?? ''}
      actions={
        p ? (
          <Button variant="quiet" size="sm" href={p.url} target="_blank" icon="arrow-up-right" aria-label="Open the original posting">
            Original
          </Button>
        ) : undefined
      }
      footer={
        p ? (
          <>
            {!engineOn && <span className="drawer-note">Applying needs live mode.</span>}
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" icon="arrow-right" onClick={apply} loading={applying}>
              Apply through the engine
            </Button>
          </>
        ) : undefined
      }
    >
      {p && (
        <div className="pd">
          <div className="pd__meta">
            <span>{p.company}</span>
            <span>{p.location}</span>
            {sen(p) && <span>{sen(p)}</span>}
            {p.companySize && <span>{sizeLabel[p.companySize]}</span>}
            {p.salary && <span className="t-num">{p.salary}</span>}
            {p.postedAt && <span>Posted {ago(p.postedAt)}</span>}
          </div>

          {p.fit !== undefined && (
            <div className="pd__fit">
              <Meter value={p.fit} size="md" label="Fit against your résumé" valueLabel={<span className="pd__fit-n">{p.fit}</span>} />
            </div>
          )}

          {(must.length > 0 || nice.length > 0) && (
            <div className="pd__skills">
              {must.length > 0 && (
                <div className="pd__skill-group">
                  <span className="t-label">Must have</span>
                  <div className="pd__chips">
                    {must.map((s) => (
                      <Chip key={s.skillId} size="sm" selected={focus === s.skillId} onClick={() => setFocus(focus === s.skillId ? undefined : s.skillId)}>
                        {s.name}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}
              {nice.length > 0 && (
                <div className="pd__skill-group">
                  <span className="t-label">Nice to have</span>
                  <div className="pd__chips">
                    {nice.map((s) => (
                      <Chip key={s.skillId} size="sm" selected={focus === s.skillId} onClick={() => setFocus(focus === s.skillId ? undefined : s.skillId)}>
                        {s.name}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}
              <p className="pd__hint t-micro">Highlighted lines are where each skill was found. Pick a skill to jump to it.</p>
            </div>
          )}

          <PostingText posting={p} focus={focus} />
        </div>
      )}
    </Drawer>
  );
}

function PostingText({ posting, focus }: { posting: Posting; focus?: string }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focus || !root.current) return;
    const el = root.current.querySelector<HTMLElement>(`[data-skill="${focus}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focus]);

  const quotes = (posting.skills ?? []).filter((s) => s.quote);

  const renderLine = (line: string, key: string) => {
    const parts: ReactNode[] = [];
    let rest = line;
    let guard = 0;
    while (rest && guard++ < 12) {
      let hit: { at: number; s: (typeof quotes)[number] } | undefined;
      for (const s of quotes) {
        const at = rest.indexOf(s.quote);
        if (at >= 0 && (!hit || at < hit.at)) hit = { at, s };
      }
      if (!hit) {
        parts.push(rest);
        break;
      }
      if (hit.at > 0) parts.push(rest.slice(0, hit.at));
      parts.push(
        <mark
          key={`${key}-${hit.s.skillId}`}
          data-skill={hit.s.skillId}
          className={['hl', `hl--${hit.s.importance}`, focus === hit.s.skillId && 'is-focus'].filter(Boolean).join(' ')}
        >
          {hit.s.quote}
          <span className="hl__tag">{hit.s.name}</span>
        </mark>,
      );
      rest = rest.slice(hit.at + hit.s.quote.length);
    }
    return parts;
  };

  const blocks = posting.text.split(/\n{2,}/);
  return (
    <div className="pd__text" ref={root}>
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        const bullets = lines.filter((l) => /^\s*[-•*]\s+/.test(l));
        if (bullets.length && bullets.length >= lines.length - 1) {
          const head = lines.length > bullets.length ? lines[0] : undefined;
          return (
            <div key={i} className="pd__block">
              {head && <h4 className="t-label pd__head">{head}</h4>}
              <ul>
                {bullets.map((l, j) => (
                  <li key={j}>{renderLine(l.replace(/^\s*[-•*]\s+/, ''), `${i}-${j}`)}</li>
                ))}
              </ul>
            </div>
          );
        }
        return (
          <p key={i} className="pd__para">
            {renderLine(b, `${i}`)}
          </p>
        );
      })}
      <a className="pd__source t-micro" href={posting.url} target="_blank" rel="noreferrer">
        {hostOf(posting.url)} <Icon name="arrow-up-right" size={12} />
      </a>
    </div>
  );
}

