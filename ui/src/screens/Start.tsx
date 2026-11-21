import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { api, ApiError, fileToBase64 } from '../api/client';
import { tracked, useTrace } from '../api/events';
import { actions, useAppState, useGap } from '../api/hooks';
import { useQuery } from '../api/query';
import type { AppState, Goal, Profile, ProfileSkill } from '../api/types';
import {
  BlueprintLoader,
  Button,
  Card,
  DropZone,
  ErrorState,
  Icon,
  Meter,
  Modal,
  QuoteBlock,
  Skeleton,
  Stat,
  Stepper,
  Tabs,
  TextArea,
  TextField,
  Toggle,
  Wordmark,
  ease,
  useNarrow,
  useToast,
} from '../ui';
import './Start.css';

const PROMISE = 'The career pivot coach that reads the market, plans the move, and learns from who replies.';

function nextMonday(from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

const blankGoal = (): Goal => ({
  targetRole: '',
  location: '',
  remote: true,
  hoursPerWeek: 8,
  weeks: 12,
  startDate: nextMonday(),
  notes: '',
});

const fmtDate = (s: string) => {
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};

export function Start() {
  const { data: state, error, refetch } = useAppState();
  const [resetOpen, setResetOpen] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  const loadDemo = async () => {
    setDemoBusy(true);
    try {
      await actions.loadDemo();
      toast({
        title: 'Avery Quinn is loaded',
        body: 'Profile, 40 postings, gap map, plan and 24 applications.',
        tone: 'success',
        action: { label: 'Open gap map', onClick: () => navigate('/gap') },
      });
    } catch (e) {
      toast({ title: 'Could not load the demo person', body: (e as Error).message, tone: 'error' });
    } finally {
      setDemoBusy(false);
    }
  };

  const reset = async () => {
    setResetBusy(true);
    try {
      await actions.reset();
      setResetOpen(false);
      toast({ title: 'Cleared. Start with a résumé or the demo person.' });
    } catch (e) {
      toast({ title: 'Could not start over', body: (e as Error).message, tone: 'error' });
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <div className="start">
      <Hero state={state} onDemo={loadDemo} demoBusy={demoBusy} onReset={() => setResetOpen(true)} />

      {!state && !error && <StartSkeleton />}
      {!state && error && (
        <ErrorState title="Could not reach the coach" message={error.message} onRetry={() => refetch().catch(() => undefined)} />
      )}

      {state && (
        <>
          <ResumeSection state={state} onDemo={loadDemo} demoBusy={demoBusy} />
          <TargetSection state={state} />
          <MarketSection state={state} />
        </>
      )}

      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        eyebrow="Start over"
        title="Clear everything?"
        footer={
          <>
            <Button variant="quiet" onClick={() => setResetOpen(false)}>
              Keep it
            </Button>
            <Button variant="primary" onClick={reset} loading={resetBusy}>
              Clear and start over
            </Button>
          </>
        }
      >
        <p className="t-mute">This removes the profile, target, postings, gap map, plan, interviews and applications. It cannot be undone.</p>
      </Modal>
    </div>
  );
}

/* hero */

function Hero({ state, onDemo, demoBusy, onReset }: { state?: AppState; onDemo: () => void; demoBusy: boolean; onReset: () => void }) {
  const profile = state?.profile;
  return (
    <section className="hero">
      <motion.div className="hero__top" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1, ease }}>
        <span className="t-label">
          <span className="t-accent">00</span> <span className="t-faint">/</span> Start
        </span>
        <span className="hero__rule" />
        {state && (
          <span className="t-micro">
            {state.mode === 'live' ? 'Live' : 'Demo'} · {state.engine.available ? 'engine on' : 'engine off'}
          </span>
        )}
      </motion.div>

      <Wordmark />

      <div className="hero__row">
        <motion.p
          className="hero__promise"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, ease, delay: 0.55 }}
        >
          {PROMISE}
        </motion.p>
        <motion.div
          className="hero__actions"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, ease, delay: 0.7 }}
        >
          {profile ? (
            <>
              <div className="hero__who">
                <span className="t-label">Working on</span>
                <span className="hero__who-name">{profile.name}</span>
                <span className="hero__who-line">
                  {profile.currentRole}
                  {state?.goal?.targetRole ? (
                    <>
                      <Icon name="arrow-right" size={14} />
                      {state.goal.targetRole}
                    </>
                  ) : null}
                </span>
              </div>
              <div className="hero__buttons">
                {state?.has.gap && (
                  <Button variant="primary" to="/gap" icon="arrow-right">
                    Open the gap map
                  </Button>
                )}
                <Button variant="quiet" onClick={onReset}>
                  Start over
                </Button>
              </div>
            </>
          ) : (
            <>
              <Button variant="primary" size="lg" icon="arrow-right" onClick={onDemo} loading={demoBusy} disabled={!state}>
                Load the demo person
              </Button>
              <span className="hero__demo-note">Avery Quinn, a backend engineer moving into AI product. Fills every screen.</span>
            </>
          )}
        </motion.div>
      </div>
    </section>
  );
}

function StartSkeleton() {
  return (
    <div className="section" aria-busy="true">
      <Skeleton width={180} height={12} />
      <Skeleton width="48%" height={34} />
      <div className="intake">
        <Skeleton height={300} radius={16} />
        <Skeleton height={300} radius={16} />
      </div>
    </div>
  );
}

function SectionHead({ index, title, text, aside }: { index: string; title: string; text?: string; aside?: ReactNode }) {
  return (
    <div className="section__head">
      <div className="section__title">
        <span className="t-label section__index">
          <b>{index}</b>
          <span className="section__rule" />
        </span>
        <h2>{title}</h2>
        {text && <p>{text}</p>}
      </div>
      {aside}
    </div>
  );
}

/* 01 résumé and profile */

function ResumeSection({ state, onDemo, demoBusy }: { state: AppState; onDemo: () => void; demoBusy: boolean }) {
  const [replacing, setReplacing] = useState(false);
  const profile = state.profile;

  if (!profile || replacing) {
    return (
      <section className="section">
        <SectionHead
          index="01"
          title="Your résumé"
          text="Tack pulls out your skills and keeps the line from your résumé that shows each one. A skill it cannot quote is left out."
          aside={
            replacing ? (
              <Button variant="quiet" onClick={() => setReplacing(false)}>
                Keep the current profile
              </Button>
            ) : undefined
          }
        />
        <Intake onDone={() => setReplacing(false)} onDemo={onDemo} demoBusy={demoBusy} showDemo={!profile} />
      </section>
    );
  }

  return (
    <section className="section">
      <SectionHead
        index="01"
        title="Profile"
        text="Check what Tack found. Rename a skill, change its level or remove it; each one keeps the résumé line behind it."
        aside={
          <Button variant="ghost" size="sm" iconLeft="upload" onClick={() => setReplacing(true)}>
            Replace résumé
          </Button>
        }
      />
      <ProfileEditor profile={profile} />
    </section>
  );
}

function Intake({ onDone, onDemo, demoBusy, showDemo }: { onDone: () => void; onDemo: () => void; demoBusy: boolean; showDemo: boolean }) {
  const [mode, setMode] = useState<'pdf' | 'text'>('pdf');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [fileName, setFileName] = useState<string>();
  const [since, setSince] = useState(0);
  const latest = useLatestSince(since);

  const submit = async (input: { text: string } | { pdfBase64: string; filename: string }) => {
    setErr(undefined);
    setBusy(true);
    setSince(Date.now());
    try {
      await actions.uploadResume(input);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File) => {
    if (file.type && file.type !== 'application/pdf') {
      setErr('That file is not a PDF. Export your résumé as PDF, or paste the text instead.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setErr('That PDF is over 5 MB. Try a smaller export, or paste the text.');
      return;
    }
    setFileName(file.name);
    submit({ pdfBase64: await fileToBase64(file), filename: file.name });
  };

  return (
    <div className="intake">
      <Card pad="lg" className="intake__card">
        <AnimatePresence mode="wait" initial={false}>
          {busy ? (
            <motion.div key="busy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4, ease }}>
              <BlueprintLoader
                height={190}
                label={fileName ? `Reading ${fileName}` : 'Reading your résumé'}
                detail={latest ? `${latest.step} · ${latest.detail}` : 'Starting'}
              />
            </motion.div>
          ) : (
            <motion.div
              key="form"
              className="intake__form"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease }}
            >
              <Tabs
                aria-label="Résumé input"
                items={[
                  { id: 'pdf', label: 'Upload PDF', icon: 'file' },
                  { id: 'text', label: 'Paste text', icon: 'list' },
                ]}
                value={mode}
                onChange={(m) => {
                  setMode(m);
                  setErr(undefined);
                }}
              />
              {mode === 'pdf' ? (
                <DropZone onFile={onFile} title="Drop your résumé here" hint="PDF up to 5 MB, or click to choose a file." />
              ) : (
                <div className="intake__paste">
                  <TextArea
                    aria-label="Résumé text"
                    placeholder="Paste the full text of your résumé: roles, dates and bullet points."
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={10}
                  />
                  <div className="intake__paste-foot">
                    <span className="t-micro">{text.trim() ? `${text.trim().split(/\s+/).length} words` : 'Plain text is fine'}</span>
                    <Button variant="primary" icon="arrow-right" disabled={text.trim().length < 40} onClick={() => submit({ text })}>
                      Read résumé
                    </Button>
                  </div>
                </div>
              )}
              {err && <ErrorState compact title="That did not work" message={err} />}
            </motion.div>
          )}
        </AnimatePresence>
      </Card>

      <div className="intake__aside">
        <span className="t-label">What happens next</span>
        <ol className="intake__next">
          <li>
            <span className="t-num">01</span>
            <div>
              <strong>Skills, with proof</strong>
              <p>Each skill keeps the résumé line that shows it. You can edit them.</p>
            </div>
          </li>
          <li>
            <span className="t-num">02</span>
            <div>
              <strong>Roles next door</strong>
              <p>Adjacent roles ranked by how much of you they already use.</p>
            </div>
          </li>
          <li>
            <span className="t-num">03</span>
            <div>
              <strong>The market, compared</strong>
              <p>About 40 postings read and set against your profile.</p>
            </div>
          </li>
        </ol>
        {showDemo && (
          <div className="intake__demo">
            <p>No résumé to hand?</p>
            <Button variant="ghost" icon="arrow-right" onClick={onDemo} loading={demoBusy}>
              Load the demo person
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function useLatestSince(since: number) {
  const t = useTrace();
  if (!since) return undefined;
  const last = t.events[t.events.length - 1];
  return last && Date.parse(last.at) >= since - 50 ? last : undefined;
}

function ProfileEditor({ profile }: { profile: Profile }) {
  const [draft, setDraft] = useState<Profile>(profile);
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const narrow = useNarrow();
  const first = narrow ? 4 : 9;
  const toast = useToast();

  useEffect(() => setDraft(profile), [profile]);

  const dirty = useMemo(() => JSON.stringify(draft.skills) !== JSON.stringify(profile.skills), [draft, profile]);
  const skills = [...draft.skills].sort((a, b) => b.level - a.level);
  const shown = showAll ? skills : skills.slice(0, first);

  const update = (id: string, patch: Partial<ProfileSkill>) =>
    setDraft((d) => ({ ...d, skills: d.skills.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  const remove = (id: string) => setDraft((d) => ({ ...d, skills: d.skills.filter((s) => s.id !== id) }));

  const save = async () => {
    setSaving(true);
    try {
      await actions.saveProfile(draft);
      toast({ title: 'Profile saved', tone: 'success' });
    } catch (e) {
      toast({ title: 'Could not save the profile', body: (e as Error).message, tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="profile">
      <Card pad="lg" className="profile__id" settle>
        <div className="profile__name-block">
          <h3 className="profile__name">{profile.name}</h3>
          <p className="profile__headline">{profile.headline}</p>
        </div>
        <div className="profile__stats">
          <Stat size="sm" label="Now" value={<span className="profile__role">{profile.currentRole}</span>} />
          <Stat size="sm" label="Experience" value={profile.yearsExperience} unit="years" />
          <Stat size="sm" label="Skills" value={draft.skills.length} unit="with proof" />
          <Stat size="sm" label="Source" value={<span className="profile__source">{profile.source === 'pdf' ? 'PDF' : profile.source === 'text' ? 'Text' : 'Demo'}</span>} />
        </div>
      </Card>

      <div className="skills-grid">
        <AnimatePresence initial={false}>
          {shown.map((s, i) => (
            <motion.div
              key={s.id}
              layout
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.6, ease, delay: Math.min(i, first) * 0.04 }}
            >
              <SkillEditor skill={s} onChange={(p) => update(s.id, p)} onRemove={() => remove(s.id)} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className="profile__foot">
        {skills.length > first ? (
          <Button variant="quiet" iconLeft={showAll ? 'chevron-up' : 'chevron-down'} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${skills.length} skills`}
          </Button>
        ) : (
          <span />
        )}
        <AnimatePresence>
          {dirty && (
            <motion.div
              className="savebar"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.4, ease }}
            >
              <span className="t-micro">Unsaved changes</span>
              <Button variant="quiet" size="sm" onClick={() => setDraft(profile)}>
                Discard
              </Button>
              <Button variant="primary" size="sm" onClick={save} loading={saving}>
                Save profile
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function SkillEditor({ skill, onChange, onRemove }: { skill: ProfileSkill; onChange: (p: Partial<ProfileSkill>) => void; onRemove: () => void }) {
  return (
    <div className="skill-ed">
      <div className="skill-ed__top">
        <input
          className="skill-ed__name"
          value={skill.name}
          aria-label="Skill name"
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <button type="button" className="skill-ed__remove" aria-label={`Remove ${skill.name}`} onClick={onRemove}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="skill-ed__level" role="radiogroup" aria-label={`${skill.name} level`}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={skill.level === n}
            aria-label={`Level ${n}`}
            className={n <= skill.level ? 'is-on' : undefined}
            onClick={() => onChange({ level: n })}
          />
        ))}
        <span className="t-num skill-ed__level-num">{skill.level}/5</span>
      </div>
      {skill.evidence[0] ? (
        <QuoteBlock size="sm" quote={skill.evidence[0]} source="Résumé" detail={skill.evidence.length > 1 ? `+${skill.evidence.length - 1} more` : undefined} />
      ) : (
        <p className="skill-ed__none">No line from the résumé. This skill will be dropped on the next read.</p>
      )}
    </div>
  );
}

/* 02 target */

function TargetSection({ state }: { state: AppState }) {
  const profile = state.profile;
  const [goal, setGoal] = useState<Goal>(state.goal ?? blankGoal());
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const first = useRef(true);
  const timer = useRef<number>(undefined);

  useEffect(() => {
    if (state.goal) setGoal(state.goal);
  }, [state.goal]);

  const set = (patch: Partial<Goal>) => {
    first.current = false;
    setGoal((g) => ({ ...g, ...patch }));
  };

  useEffect(() => {
    if (first.current || !profile) return;
    window.clearTimeout(timer.current);
    if (!goal.targetRole.trim()) return;
    timer.current = window.setTimeout(async () => {
      setSaveState('saving');
      try {
        await actions.saveGoal(goal);
        setSaveState('saved');
      } catch {
        setSaveState('error');
      }
    }, 700);
    return () => window.clearTimeout(timer.current);
  }, [goal, profile]);

  const roles = useQuery(`roles:${profile?.name ?? ''}:${profile?.skills.length ?? 0}`, api.suggestRoles, { enabled: !!profile });
  const disabled = !profile;
  const total = goal.hoursPerWeek * goal.weeks;

  return (
    <section className={['section', disabled && 'is-locked'].filter(Boolean).join(' ')} aria-disabled={disabled || undefined}>
      <SectionHead
        index="02"
        title="Target"
        text="The role you want next, where, and how much time you have each week."
        aside={
          <span className={`savestate t-micro is-${saveState}`} aria-live="polite">
            {saveState === 'saving' ? 'Saving' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : ''}
          </span>
        }
      />
      <Card pad="lg" className="target">
        <div className="target__role">
          <TextField
            large
            label="Target role"
            placeholder="AI Product Manager"
            value={goal.targetRole}
            disabled={disabled}
            onChange={(e) => set({ targetRole: e.target.value })}
          />
          <div className="target__suggest">
            <span className="t-label">Roles next door</span>
            {disabled ? (
              <p className="t-faint target__hint">Suggestions appear once Tack has read a résumé.</p>
            ) : roles.error ? (
              <ErrorState compact title="Could not suggest roles" message={roles.error.message} onRetry={() => roles.refetch().catch(() => undefined)} />
            ) : !roles.data ? (
              <div className="roles">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} height={92} radius={12} />
                ))}
              </div>
            ) : (
              <div className="roles">
                {roles.data.roles.map((r, i) => {
                  const on = r.role.toLowerCase() === goal.targetRole.trim().toLowerCase();
                  return (
                    <motion.button
                      key={r.role}
                      type="button"
                      className={['role', on && 'is-on'].filter(Boolean).join(' ')}
                      onClick={() => set({ targetRole: r.role })}
                      aria-pressed={on}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.6, ease, delay: i * 0.05 }}
                    >
                      <span className="role__top">
                        <span className="role__name">{r.role}</span>
                        <span className="role__overlap t-num">{r.overlap}%</span>
                      </span>
                      <Meter value={r.overlap} size="xs" tone={on ? 'accent' : 'paper'} aria-label={`${r.overlap}% overlap`} />
                      <span className="role__why">{r.why}</span>
                    </motion.button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="target__grid">
          <TextField label="Location" placeholder="Bengaluru" value={goal.location} disabled={disabled} onChange={(e) => set({ location: e.target.value })} />
          <div className="target__toggle">
            <Toggle checked={goal.remote} onChange={(v) => set({ remote: v })} label="Include remote roles" hint="Remote postings in your country" disabled={disabled} />
          </div>
          <Stepper label="Hours a week" value={goal.hoursPerWeek} min={2} max={40} unit="h" onChange={(v) => set({ hoursPerWeek: v })} />
          <Stepper label="Weeks" value={goal.weeks} min={4} max={26} unit="wk" onChange={(v) => set({ weeks: v })} />
        </div>

        <p className="target__budget t-mono">
          <span className="t-paper">{goal.hoursPerWeek} h</span> a week <span className="t-faint">×</span> <span className="t-paper">{goal.weeks}</span> weeks{' '}
          <span className="t-faint">=</span> <span className="t-accent">{total} hours</span>, starting {fmtDate(goal.startDate)}
        </p>
      </Card>
    </section>
  );
}

/* 03 read the market */

const STAGES = ['Collect postings', 'Extract skills', 'Score the gap'];
const SCORE_STEPS = new Set(['normalise', 'score', 'bridge', 'readiness', 'maths']);

function MarketSection({ state }: { state: AppState }) {
  const navigate = useNavigate();
  const toast = useToast();
  const gap = useGap();
  const [phase, setPhase] = useState<'idle' | 'harvest' | 'gap' | 'error'>('idle');
  const [err, setErr] = useState<ApiError>();
  const [since, setSince] = useState(0);
  const latest = useLatestSince(since);
  const mounted = useRef(true);
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const goal = state.goal;
  const ready = !!state.profile && !!goal?.targetRole.trim();
  const running = phase === 'harvest' || phase === 'gap';
  const stage = phase === 'harvest' ? 0 : latest && SCORE_STEPS.has(latest.step) ? 2 : 1;

  const run = async () => {
    setErr(undefined);
    setSince(Date.now());
    setPhase('harvest');
    // The trace rail opens and the column reflows; keep the run card on screen.
    window.setTimeout(() => sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 750);
    try {
      const result = await tracked('Reading the market', async () => {
        await actions.harvest(40);
        if (mounted.current) setPhase('gap');
        return actions.buildGap();
      });
      if (!mounted.current) return;
      setPhase('idle');
      toast({ title: 'Gap map ready', body: `Readiness ${result.readiness} of 100, from ${result.postingCount} postings.`, tone: 'success' });
      navigate('/gap');
    } catch (e) {
      if (!mounted.current) return;
      setErr(e as ApiError);
      setPhase('error');
    }
  };

  return (
    <section ref={sectionRef} className={['section', !state.profile && 'is-locked'].filter(Boolean).join(' ')}>
      <SectionHead index="03" title="Read the market" />
      <Card pad="lg" className="runcard">
        <AnimatePresence mode="wait" initial={false}>
          {running ? (
            <motion.div key="run" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5, ease }}>
              <BlueprintLoader
                label={phase === 'harvest' ? 'Collecting postings' : stage === 2 ? 'Scoring the gap' : 'Extracting skills'}
                detail={latest ? `${latest.step} · ${latest.detail}` : 'Starting'}
                stages={STAGES}
                stage={stage}
                height={240}
              />
            </motion.div>
          ) : (
            <motion.div
              key="idle"
              className="runcard__idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5, ease }}
            >
              <div className="runcard__text">
                <p className="runcard__lead">
                  Tack collects about 40 postings for <em>{goal?.targetRole || 'your target role'}</em>
                  {goal?.location ? (
                    <>
                      {' '}
                      in <em>{goal.location}</em>
                    </>
                  ) : null}
                  , pulls out the skills each one asks for with the exact line, and sets them against your résumé.
                </p>
                <ol className="runcard__steps">
                  {STAGES.map((s, i) => (
                    <li key={s}>
                      <span className="t-num">{String(i + 1).padStart(2, '0')}</span>
                      {s}
                    </li>
                  ))}
                </ol>
                <p className="runcard__mode t-micro">
                  {state.engine.available ? 'Live: open roles are read straight from public company job boards.' : 'Demo: the engine is off, so Tack reads the bundled sample of 40 postings.'}
                </p>
              </div>
              <div className="runcard__actions">
                {phase === 'error' && err && <ErrorState compact title="The run stopped" message={err.message} />}
                {gap.data && (
                  <div className="runcard__last">
                    <span className="t-label">Last read</span>
                    <span className="t-num runcard__last-figures">
                      {gap.data.postingCount} postings <span className="t-faint">·</span> readiness {gap.data.readiness}
                    </span>
                  </div>
                )}
                <div className="runcard__buttons">
                  <Button variant="primary" size="lg" icon="arrow-right" onClick={run} disabled={!ready}>
                    {gap.data ? 'Read the market again' : phase === 'error' ? 'Try again' : 'Read the market'}
                  </Button>
                  {gap.data && (
                    <Button variant="ghost" size="lg" to="/gap">
                      Open the gap map
                    </Button>
                  )}
                </div>
                {!ready && (
                  <span className="runcard__hint">{!state.profile ? 'Add a résumé first.' : 'Add a target role first.'}</span>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>
    </section>
  );
}
