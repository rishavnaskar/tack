import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { actions, keys } from '../../api/hooks';
import { getQueryData, setQueryData } from '../../api/query';
import type { AppStatus, Application, Posting } from '../../api/types';
import { hostOf, shortDate } from '../../lib/format';
import { Button, Chip, Drawer, Icon, Modal, Stat, Stepper, Tabs, TextArea, TextField, ease, useNarrow, useToast } from '../../ui';
import { STATUSES, STATUS_HINT, STATUS_LABEL, byStatus, daysSince, humanise, isResponse } from './model';

export function SectionHead({ index, title, text, aside }: { index: string; title: string; text?: string; aside?: ReactNode }) {
  return (
    <div className="section__head">
      <div className="section__title">
        <span className="t-label section__index">
          <b>{index}</b>
          <span className="tr-rule" />
        </span>
        <h2>{title}</h2>
        {text && <p>{text}</p>}
      </div>
      {aside}
    </div>
  );
}

/** Moves an application, optimistic on the board, then lets the server relearn the insights. */
function useMove() {
  const toast = useToast();
  return async (id: string, status: AppStatus, note?: string) => {
    const before = getQueryData<Application[]>(keys.applications);
    const app = before?.find((a) => a.id === id);
    if (!app || (app.status === status && !note)) return;
    setQueryData<Application[]>(keys.applications, (all) => (all ?? []).map((a) => (a.id === id ? { ...a, status } : a)));
    try {
      await actions.setApplicationStatus(id, status, note);
    } catch (e) {
      if (before) setQueryData(keys.applications, before);
      toast({ title: `Could not move ${app.company}`, body: (e as Error).message, tone: 'error' });
    }
  };
}

export function Pipeline({ apps, onOpen }: { apps: Application[]; onOpen: (id: string) => void }) {
  const narrow = useNarrow();
  const move = useMove();
  const groups = useMemo(() => byStatus(apps), [apps]);
  const responded = apps.filter((a) => isResponse(a.status)).length;

  return (
    <section className="section">
      <SectionHead
        index="03"
        title="Pipeline"
        text={narrow ? 'Pick a status to see its cards. Use the menu on a card to move it.' : 'Drag a card to another column, or use its menu. Every move feeds the numbers at the top.'}
        aside={
          <span className="t-micro">
            {apps.length} sent · {responded} responded
          </span>
        }
      />
      {narrow ? <StatusList groups={groups} onOpen={onOpen} onMove={move} /> : <Board groups={groups} onOpen={onOpen} onMove={move} />}
    </section>
  );
}

type Groups = Map<AppStatus, Application[]>;
type Move = (id: string, status: AppStatus, note?: string) => Promise<void>;

function Board({ groups, onOpen, onMove }: { groups: Groups; onOpen: (id: string) => void; onMove: Move }) {
  const [dragId, setDragId] = useState<string>();
  const [over, setOver] = useState<AppStatus>();

  const drop = (status: AppStatus) => (e: DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragId;
    setOver(undefined);
    setDragId(undefined);
    if (id) onMove(id, status);
  };

  return (
    <LayoutGroup>
      <div className="board" role="list" aria-label="Applications by status">
        {STATUSES.map((st, ci) => {
          const cards = groups.get(st) ?? [];
          const from = dragId ? [...groups.values()].flat().find((a) => a.id === dragId)?.status : undefined;
          return (
            <motion.div
              key={st}
              role="listitem"
              className={['col', `col--${st}`, over === st && from !== st && 'is-over', dragId && 'is-dragging'].filter(Boolean).join(' ')}
              onDragOver={(e: DragEvent) => {
                if (!dragId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (over !== st) setOver(st);
              }}
              onDragLeave={(e: DragEvent) => {
                if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver((o) => (o === st ? undefined : o));
              }}
              onDrop={drop(st)}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease, delay: 0.05 + ci * 0.04 }}
            >
              <div className="col__head" title={STATUS_HINT[st]}>
                <span className={['col__dot', `dot--${st}`].join(' ')} aria-hidden="true" />
                <span className="col__name">{STATUS_LABEL[st]}</span>
                <span className="col__n t-num">{cards.length}</span>
              </div>
              <div className="col__cards">
                <AnimatePresence initial={false}>
                  {cards.map((a) => (
                    <AppCard
                      key={a.id}
                      app={a}
                      dragging={dragId === a.id}
                      onOpen={() => onOpen(a.id)}
                      onMove={(s) => onMove(a.id, s)}
                      onDragStart={() => setDragId(a.id)}
                      onDragEnd={() => {
                        setDragId(undefined);
                        setOver(undefined);
                      }}
                    />
                  ))}
                </AnimatePresence>
                {!cards.length && <div className="col__empty">{dragId ? 'Drop here' : 'None'}</div>}
              </div>
            </motion.div>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

function StatusList({ groups, onOpen, onMove }: { groups: Groups; onOpen: (id: string) => void; onMove: Move }) {
  const [tab, setTab] = useState<AppStatus>(() => STATUSES.find((s) => (groups.get(s)?.length ?? 0) > 0) ?? 'applied');
  const cards = groups.get(tab) ?? [];
  return (
    <div className="slist">
      <Tabs
        size="sm"
        aria-label="Status"
        items={STATUSES.map((s) => ({ id: s, label: STATUS_LABEL[s], count: groups.get(s)?.length ?? 0 }))}
        value={tab}
        onChange={(v) => setTab(v)}
      />
      <p className="slist__hint t-micro">{STATUS_HINT[tab]}</p>
      <LayoutGroup>
        <div className="slist__cards">
          <AnimatePresence initial={false}>
            {cards.map((a) => (
              <AppCard key={a.id} app={a} onOpen={() => onOpen(a.id)} onMove={(s) => onMove(a.id, s)} />
            ))}
          </AnimatePresence>
          {!cards.length && <div className="col__empty">Nothing in {STATUS_LABEL[tab].toLowerCase()} right now.</div>}
        </div>
      </LayoutGroup>
    </div>
  );
}

function Origin({ origin }: { origin: Application['origin'] }) {
  return (
    <span className={`origin origin--${origin}`} title={origin === 'fanfold' ? 'Sent through the engine' : origin === 'manual' ? 'Logged by hand' : 'Demo data'}>
      {origin}
    </span>
  );
}

function AppCard({
  app: a,
  dragging,
  onOpen,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  app: Application;
  dragging?: boolean;
  onOpen: () => void;
  onMove: (s: AppStatus) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}) {
  const days = daysSince(a.appliedAt);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  };
  return (
    <motion.div
      layout
      layoutId={`app-${a.id}`}
      className="appc-wrap"
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.5, ease }}
    >
      <div
        className={['appc', `appc--${a.status}`, dragging && 'is-dragging'].filter(Boolean).join(' ')}
        draggable={!!onDragStart}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', a.id);
          e.dataTransfer.effectAllowed = 'move';
          onDragStart?.();
        }}
        onDragEnd={onDragEnd}
        onClick={onOpen}
        onKeyDown={onKey}
        role="button"
        tabIndex={0}
        aria-label={`${a.company}, ${a.title}, ${STATUS_LABEL[a.status]}, fit ${a.fit}, applied ${days} days ago`}
      >
        <div className="appc__top">
          <span className="appc__company">{a.company}</span>
          <StatusMenu value={a.status} onPick={onMove} label={a.company} />
        </div>
        <span className="appc__title">{a.title}</span>
        <div className="appc__foot">
          <span className="appc__fit t-num" title="Fit against your résumé">
            {a.fit}
            <span className="t-faint"> fit</span>
          </span>
          <span className="appc__days t-num" title={`Applied ${shortDate(a.appliedAt)}`}>
            {days}d
          </span>
          <Origin origin={a.origin} />
        </div>
      </div>
    </motion.div>
  );
}

// Below the button, or above it when there is no room; kept inside the viewport.
function place(r: DOMRect) {
  const w = 196;
  const h = 7 * 36 + 40;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  const top = r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
  return { top, left };
}

function StatusMenu({ value, onPick, label }: { value: AppStatus; onPick: (s: AppStatus) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>();
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (menu.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
    };
    const onScroll = () => {
      const r = btn.current?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > window.innerHeight) setOpen(false);
      else setPos(place(r));
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    const t = window.setTimeout(() => menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(), 20);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const toggle = (e: ReactMouseEvent) => {
    e.stopPropagation();
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos(place(r));
    setOpen((o) => !o);
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={['smenu__btn', open && 'is-open'].filter(Boolean).join(' ')}
        onClick={toggle}
        onKeyDown={(e) => e.stopPropagation()}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Move ${label}`}
      >
        <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="4.5" cy="10" r="1.4" fill="currentColor" />
          <circle cx="10" cy="10" r="1.4" fill="currentColor" />
          <circle cx="15.5" cy="10" r="1.4" fill="currentColor" />
        </svg>
      </button>
      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={menu}
              className="smenu"
              role="menu"
              style={{ top: pos.top, left: pos.left }}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.22, ease }}
              onClick={(e) => e.stopPropagation()}
            >
              <span className="smenu__label t-label">Move to</span>
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="menuitemradio"
                  aria-checked={s === value}
                  className={['smenu__item', s === value && 'is-on'].filter(Boolean).join(' ')}
                  onClick={() => {
                    setOpen(false);
                    if (s !== value) onPick(s);
                  }}
                >
                  <span className={['col__dot', `dot--${s}`].join(' ')} aria-hidden="true" />
                  {STATUS_LABEL[s]}
                  {s === value && <Icon name="check" size={14} />}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

/* drawer */

export function AppDrawer({ app, onClose }: { app?: Application; onClose: () => void }) {
  const last = useRef<Application | undefined>(app);
  if (app) last.current = app;
  const a = app ?? last.current;
  const move = useMove();
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => setNote(''), [app?.id]);

  const addNote = async () => {
    if (!a || !note.trim()) return;
    setSaving(true);
    try {
      await actions.setApplicationStatus(a.id, a.status, note.trim());
      setNote('');
    } catch (e) {
      toast({ title: 'Could not save the note', body: (e as Error).message, tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const events = a ? [...a.events].sort((x, y) => y.at.localeCompare(x.at)) : [];

  return (
    <Drawer
      open={!!app}
      onClose={onClose}
      width={600}
      eyebrow={a ? <span className="t-mono">{a.url ? hostOf(a.url) : humanise(a.source)}</span> : undefined}
      title={a ? a.title : ''}
      actions={
        a?.url ? (
          <Button variant="quiet" size="sm" href={a.url} target="_blank" icon="arrow-up-right" aria-label="Open the posting">
            Posting
          </Button>
        ) : undefined
      }
    >
      {a && (
        <div className="ad">
          <p className="ad__company">
            {a.company}
            <span className="t-faint"> · </span>
            <span className="t-mute">{[humanise(a.roleFamily), humanise(a.seniority), humanise(a.companySize)].join(' · ')}</span>
          </p>

          <div className="ad__status">
            <span className="t-label">Status</span>
            <div className="ad__chips" role="radiogroup" aria-label="Status">
              {STATUSES.map((s) => (
                <Chip key={s} size="sm" selected={a.status === s} onClick={() => move(a.id, s)} role="radio" aria-checked={a.status === s}>
                  {STATUS_LABEL[s]}
                </Chip>
              ))}
            </div>
            <p className="t-micro ad__hint">{STATUS_HINT[a.status]}. Moving it updates the insights.</p>
          </div>

          <div className="ad__stats">
            <Stat size="sm" label="Fit" value={a.fit} unit="/100" />
            <Stat size="sm" label="Applied" value={daysSince(a.appliedAt)} unit="days ago" note={shortDate(a.appliedAt)} />
            <Stat size="sm" label="Source" value={<span className="ad__word">{humanise(a.source)}</span>} />
            <Stat size="sm" label="Origin" value={<span className="ad__word">{humanise(a.origin)}</span>} />
          </div>

          <div className="ad__timeline">
            <span className="t-label">Timeline</span>
            <ol className="tl">
              {events.map((e, i) => (
                <motion.li
                  key={`${e.at}-${e.kind}-${i}`}
                  className={['tl__item', `tl--${e.kind}`, i === 0 && 'is-latest'].filter(Boolean).join(' ')}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.5, ease, delay: Math.min(i, 8) * 0.04 }}
                >
                  <span className="tl__dot" aria-hidden="true" />
                  <span className="tl__when t-num">{shortDate(e.at)}</span>
                  <span className="tl__kind">{STATUS_LABEL[e.kind as AppStatus] ?? humanise(e.kind)}</span>
                  <span className="tl__note">{e.note}</span>
                </motion.li>
              ))}
            </ol>
          </div>

          <div className="ad__note">
            <TextArea label="Add a note" placeholder="Who you spoke to, what they asked, when to follow up." value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
            <div className="ad__note-foot">
              <span className="t-micro">Saved to the timeline under the current status</span>
              <Button variant="ghost" size="sm" onClick={addNote} loading={saving} disabled={!note.trim()}>
                Add to timeline
              </Button>
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}

/* add */

const today = () => new Date().toISOString().slice(0, 10);
const SIZES = ['startup', 'scaleup', 'enterprise'] as const;

interface Draft {
  postingId?: string;
  company: string;
  title: string;
  url: string;
  roleFamily: string;
  seniority: string;
  companySize: string;
  source: string;
  fit: number;
  status: AppStatus;
  appliedAt: string;
}

const blank = (): Draft => ({ company: '', title: '', url: '', roleFamily: '', seniority: '', companySize: '', source: '', fit: 50, status: 'applied', appliedAt: today() });

export function AddApplication({ open, onClose, postings }: { open: boolean; onClose: () => void; postings: Posting[] }) {
  const [d, setD] = useState<Draft>(blank);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (open) {
      setD(blank());
      setQ('');
      setTried(false);
    }
  }, [open]);

  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return postings.filter((p) => `${p.company} ${p.title}`.toLowerCase().includes(needle)).slice(0, 4);
  }, [postings, q]);

  const pick = (p: Posting) => {
    set({
      postingId: p.id,
      company: p.company,
      title: p.title,
      url: p.url,
      roleFamily: p.roleFamily ?? '',
      seniority: p.seniority ?? '',
      companySize: p.companySize ?? '',
      source: p.source ?? '',
      fit: p.fit ?? 50,
    });
    setQ('');
  };

  const submit = async () => {
    setTried(true);
    if (!d.company.trim() || !d.title.trim()) return;
    setBusy(true);
    try {
      const body: Partial<Application> = {
        company: d.company.trim(),
        title: d.title.trim(),
        fit: d.fit,
        status: d.status,
        appliedAt: new Date(`${d.appliedAt}T09:00:00`).toISOString(),
        ...(d.postingId ? { postingId: d.postingId } : {}),
        ...(d.url.trim() ? { url: d.url.trim() } : {}),
        ...(d.roleFamily.trim() ? { roleFamily: d.roleFamily.trim() } : {}),
        ...(d.seniority.trim() ? { seniority: d.seniority.trim() } : {}),
        ...(d.companySize ? { companySize: d.companySize } : {}),
        source: d.source.trim() || 'manual',
      };
      const created = await actions.addApplication(body);
      toast({ title: `${created.company} added`, body: `In ${STATUS_LABEL[created.status].toLowerCase()}. The insights now count it.`, tone: 'success' });
      onClose();
    } catch (e) {
      toast({ title: 'Could not add it', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={620}
      eyebrow="Log by hand"
      title="Add an application"
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" iconLeft="plus" onClick={submit} loading={busy}>
            Add application
          </Button>
        </>
      }
    >
      <div className="add">
        {postings.length > 0 && (
          <div className="add__pick">
            <TextField
              label="From a posting Tack read"
              placeholder="Search by company or title"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              hint={d.postingId ? `Linked to the posting. Details filled in from it.` : 'Optional. Picking one fills in the details below.'}
            />
            {hits.length > 0 && (
              <ul className="add__hits">
                {hits.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => pick(p)}>
                      <span className="add__hit-co">{p.company}</span>
                      <span className="add__hit-title">{p.title}</span>
                      {p.fit !== undefined && <span className="t-num add__hit-fit">{p.fit}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="add__grid">
          <TextField label="Company" value={d.company} onChange={(e) => set({ company: e.target.value, postingId: undefined })} error={tried && !d.company.trim() ? 'Needed' : undefined} />
          <TextField label="Role title" value={d.title} onChange={(e) => set({ title: e.target.value, postingId: undefined })} error={tried && !d.title.trim() ? 'Needed' : undefined} />
          <TextField className="add__wide" label="Posting link" placeholder="https://" value={d.url} onChange={(e) => set({ url: e.target.value })} />
          <TextField label="Role family" placeholder="Growth, platform, AI" value={d.roleFamily} onChange={(e) => set({ roleFamily: e.target.value })} />
          <TextField label="Seniority" placeholder="Mid, senior" value={d.seniority} onChange={(e) => set({ seniority: e.target.value })} />
          <TextField label="Source" placeholder="Referral, careers page" value={d.source} onChange={(e) => set({ source: e.target.value })} />
          <TextField label="Applied on" type="date" value={d.appliedAt} max={today()} onChange={(e) => set({ appliedAt: e.target.value || today() })} />
          <Stepper label="Fit" value={d.fit} min={0} max={100} step={5} unit="/100" onChange={(v) => set({ fit: v })} />
          <div className="add__field add__size">
            <span className="t-label">Company size</span>
            <div className="add__chips">
              {SIZES.map((s) => (
                <Chip key={s} size="sm" selected={d.companySize === s} onClick={() => set({ companySize: d.companySize === s ? '' : s })}>
                  {humanise(s)}
                </Chip>
              ))}
            </div>
          </div>
          <div className="add__field add__wide">
            <span className="t-label">Status</span>
            <div className="add__chips">
              {STATUSES.map((s) => (
                <Chip key={s} size="sm" selected={d.status === s} onClick={() => set({ status: s })}>
                  {STATUS_LABEL[s]}
                </Chip>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
