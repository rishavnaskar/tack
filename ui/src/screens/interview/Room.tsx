import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { actions, keys, useGap } from '../../api/hooks';
import { invalidate } from '../../api/query';
import type { GapSkill, InterviewQuestion, InterviewSession, InterviewTurn, Posting } from '../../api/types';
import { pad2, shortDate } from '../../lib/format';
import { Button, Card, Chip, Icon, RevealWords, Tabs, ease } from '../../ui';
import {
  ANCHORS,
  CRITERIA,
  criterionAverages,
  firstOpen,
  highlightRuns,
  isDone,
  kindLabel,
  placeholderParts,
  postingLabel,
  scoreFor,
  sessionScore,
  skillName,
  skillResults,
  turnFor,
  verdict,
  wordCount,
} from './model';
import { Pips, useLatestSince } from './parts';

type View = { at: 'question' | 'feedback'; i: number } | { at: 'summary' };

interface RoomProps {
  session: InterviewSession;
  sessions: InterviewSession[];
  postings?: Posting[];
  onLeave: () => void;
}

export function SessionRoom({ session, sessions, postings, onLeave }: RoomProps) {
  const gap = useGap();
  const skills = gap.data?.skills;
  const [view, setView] = useState<View>(() => (isDone(session) ? { at: 'summary' } : { at: 'question', i: firstOpen(session) }));
  const [retry, setRetry] = useState<Record<string, string>>({});
  const posting = postingLabel(postings, session.postingId);
  const done = isDone(session);

  const go = (v: View) => {
    setView(v);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const nextAfter = (i: number) => {
    const n = session.questions.length;
    for (let k = 1; k <= n; k++) {
      const j = (i + k) % n;
      if (!turnFor(session, session.questions[j].id)) return j;
    }
    return undefined;
  };

  const shown: View = view.at === 'feedback' && !turnFor(session, session.questions[view.i]?.id ?? '') ? { at: 'question', i: view.i } : view;
  const viewKey = shown.at === 'summary' ? 'summary' : `${shown.at}-${shown.i}`;

  return (
    <div className="room">
      <RoomBar session={session} posting={posting} view={shown} onGo={go} onLeave={onLeave} />

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={viewKey}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.55, ease }}
        >
          {shown.at === 'question' ? (
            <QuestionStage
              session={session}
              index={shown.i}
              skills={skills}
              postings={postings}
              seed={retry[session.questions[shown.i]?.id ?? '']}
              onScored={(next) => {
                const q = session.questions[shown.i];
                setRetry((r) => ({ ...r, [q.id]: '' }));
                if (isDone(next) && !done) invalidate(keys.gap, keys.plan, keys.brief, keys.postings);
                go({ at: 'feedback', i: shown.i });
              }}
            />
          ) : shown.at === 'feedback' ? (
            <FeedbackStage
              session={session}
              index={shown.i}
              skills={skills}
              onRetry={() => {
                const q = session.questions[shown.i];
                setRetry((r) => ({ ...r, [q.id]: turnFor(session, q.id)?.answer ?? '' }));
                go({ at: 'question', i: shown.i });
              }}
              onNext={() => {
                const j = nextAfter(shown.i);
                go(j === undefined ? { at: 'summary' } : { at: 'question', i: j });
              }}
              nextLabel={nextAfter(shown.i) === undefined ? 'See the session summary' : 'Next question'}
            />
          ) : (
            <SummaryStage session={session} sessions={sessions} skills={skills} onGo={go} onLeave={onLeave} />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/* bar */

function RoomBar({
  session,
  posting,
  view,
  onGo,
  onLeave,
}: {
  session: InterviewSession;
  posting?: { company: string; title: string };
  view: View;
  onGo: (v: View) => void;
  onLeave: () => void;
}) {
  const done = isDone(session);
  return (
    <header className="room__bar">
      <motion.div className="room__eyebrow" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, ease }}>
        <span className="t-label">
          <span className="t-accent">05</span> <span className="t-faint">/</span> Interview
        </span>
        <span className="room__rule" />
        <Button variant="quiet" size="sm" iconLeft="arrow-left" onClick={onLeave}>
          All sessions
        </Button>
      </motion.div>
      <div className="room__head">
        <div className="room__titles">
          <h1 className="room__name">{kindLabel(session.kind)} session</h1>
          <span className="room__ctx">
            {posting ? (
              <>
                Against <em>{posting.company}</em> · {posting.title}
              </>
            ) : (
              'Across your target jobs'
            )}
            <span className="t-faint"> · {shortDate(session.startedAt)}</span>
          </span>
        </div>
        <nav className="steps" aria-label="Questions in this session">
          {session.questions.map((q, i) => {
            const turn = turnFor(session, q.id);
            const current = view.at !== 'summary' && view.i === i;
            return (
              <button
                key={q.id}
                type="button"
                className={['step', turn && 'is-done', current && 'is-current'].filter(Boolean).join(' ')}
                onClick={() => onGo(turn ? { at: 'feedback', i } : { at: 'question', i })}
                aria-current={current ? 'step' : undefined}
                aria-label={`Question ${i + 1}${turn ? `, scored ${turn.overall}` : ''}`}
              >
                <span className="step__bar" />
                <span className="step__label t-num">Q{i + 1}</span>
                <span className="step__score t-num">{turn ? turn.overall : ''}</span>
              </button>
            );
          })}
          <button
            type="button"
            className={['step step--sum', done && 'is-done', view.at === 'summary' && 'is-current'].filter(Boolean).join(' ')}
            onClick={() => onGo({ at: 'summary' })}
            disabled={!done}
            aria-current={view.at === 'summary' ? 'step' : undefined}
          >
            <span className="step__bar" />
            <span className="step__label t-num">Sum</span>
            <span className="step__score t-num">{done ? sessionScore(session) : ''}</span>
          </button>
        </nav>
      </div>
    </header>
  );
}

/* question */

interface SpeechResultList {
  length: number;
  [i: number]: { isFinal: boolean; 0: { transcript: string } };
}
interface SpeechRec {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: SpeechResultList }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechCtor = new () => SpeechRec;

function recognition(): SpeechCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

function useDictation(onFinal: (text: string) => void) {
  const Ctor = useMemo(recognition, []);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string>();
  const rec = useRef<SpeechRec | null>(null);
  const cb = useRef(onFinal);
  cb.current = onFinal;

  useEffect(() => () => rec.current?.abort(), []);

  const start = () => {
    if (!Ctor || rec.current) return;
    try {
      const r = new Ctor();
      r.continuous = true;
      r.interimResults = true;
      r.lang = navigator.language || 'en-GB';
      r.onresult = (e) => {
        let live = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) cb.current(res[0].transcript.trim());
          else live += res[0].transcript;
        }
        setInterim(live);
      };
      r.onerror = (e) => setError(e.error === 'not-allowed' ? 'Microphone access was blocked. Typing works just as well.' : 'Dictation stopped.');
      r.onend = () => {
        rec.current = null;
        setListening(false);
        setInterim('');
      };
      rec.current = r;
      r.start();
      setError(undefined);
      setListening(true);
    } catch {
      rec.current = null;
      setListening(false);
      setError('Voice input is not available in this browser.');
    }
  };

  const stop = () => rec.current?.stop();
  return { supported: !!Ctor, listening, interim, error, start, stop };
}

const draftKey = (s: string, q: string) => `tack.iv.draft.${s}.${q}`;
function readDraft(k: string) {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
}
function writeDraft(k: string, v: string) {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* storage may be blocked */
  }
}

const clock = (s: number) => `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;

function QuestionStage({
  session,
  index,
  skills,
  postings,
  seed,
  onScored,
}: {
  session: InterviewSession;
  index: number;
  skills?: GapSkill[];
  postings?: Posting[];
  seed?: string;
  onScored: (s: InterviewSession) => void;
}) {
  const q = session.questions[index];
  const key = draftKey(session.id, q.id);
  const [text, setText] = useState(() => seed || readDraft(key));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [since, setSince] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const latest = useLatestSince(since);
  const area = useRef<HTMLTextAreaElement>(null);
  const words = wordCount(text);

  const dict = useDictation((chunk) => setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')} ${chunk}` : chunk)));

  useEffect(() => writeDraft(key, text), [key, text]);

  useEffect(() => {
    if (busy) return;
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [busy]);

  useEffect(() => {
    const t = window.setTimeout(() => area.current?.focus({ preventScroll: true }), 900);
    return () => window.clearTimeout(t);
  }, []);

  const submit = async () => {
    const answer = text.trim();
    if (wordCount(answer) < 8) {
      setErr('Write at least a couple of sentences so we have enough to score.');
      return;
    }
    dict.stop();
    setErr(undefined);
    setBusy(true);
    setSince(Date.now());
    try {
      const res = await actions.answer(session.id, q.id, answer);
      writeDraft(key, '');
      onScored(res.session);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!busy) submit();
    }
  };

  const from = postingLabel(postings, q.fromPosting);
  const late = elapsed >= 180;

  return (
    <section className="stage" aria-labelledby={`q-${q.id}`}>
      <QuestionHead question={q} index={index} total={session.questions.length} skills={skills} from={from} />

      <h2 className="stage__q" id={`q-${q.id}`}>
        <RevealWords text={q.text} delay={0.1} step={0.035} />
      </h2>

      <motion.div
        className={['answer', busy && 'is-busy', dict.listening && 'is-listening'].filter(Boolean).join(' ')}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.9, ease, delay: 0.45 }}
      >
        <label className="visually-hidden" htmlFor={`a-${q.id}`}>
          Your answer
        </label>
        <textarea
          ref={area}
          id={`a-${q.id}`}
          className="answer__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          readOnly={busy}
          placeholder="Answer like you would out loud. Say what the situation was, what you did and why, and what happened."
          rows={9}
        />
        {dict.interim && <p className="answer__interim">{dict.interim}</p>}

        <AnimatePresence mode="wait" initial={false}>
          {busy ? (
            <motion.div key="judge" className="judge" role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4, ease }}>
              <div className="judge__top">
                <span className="pulse-dot" />
                <span className="judge__label">Reviewing your answer</span>
              </div>
              <span className="judge__detail t-mono">{latest ? `${latest.step} · ${latest.detail}` : 'Sending your answer'}</span>
              <ol className="judge__crit" aria-hidden="true">
                {CRITERIA.map((c, i) => (
                  <li key={c} style={{ animationDelay: `${i * 0.4}s` }}>
                    {c}
                  </li>
                ))}
              </ol>
            </motion.div>
          ) : (
            <motion.div key="foot" className="answer__foot" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4, ease }}>
              <div className="answer__meta">
                {dict.supported && (
                  <button
                    type="button"
                    className={['mic', dict.listening && 'is-on'].filter(Boolean).join(' ')}
                    onClick={dict.listening ? dict.stop : dict.start}
                    aria-pressed={dict.listening}
                  >
                    <MicIcon />
                    {dict.listening ? 'Stop dictation' : 'Dictate'}
                  </button>
                )}
                <span className="answer__count t-num">
                  {words} <span className="t-faint">words</span>
                </span>
                <span className={['answer__clock t-num', late && 'is-late'].filter(Boolean).join(' ')} title="Time on this question">
                  {clock(elapsed)}
                </span>
                <span className="answer__hint">
                  {late ? 'Past three minutes. Wrap up with your result.' : words > 0 && words < 60 ? 'Most strong answers are 120 to 250 words.' : ''}
                </span>
              </div>
              <div className="answer__go">
                <span className="answer__kbd t-micro">⌘ Enter</span>
                <Button variant="primary" icon="arrow-right" onClick={submit} disabled={!text.trim()}>
                  Score this answer
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {(err || dict.error) && <p className="stage__err t-mono">{err ?? dict.error}</p>}
    </section>
  );
}

function QuestionHead({
  question: q,
  index,
  total,
  skills,
  from,
}: {
  question: InterviewQuestion;
  index: number;
  total: number;
  skills?: GapSkill[];
  from?: { company: string; title: string };
}) {
  return (
    <motion.div className="stage__meta" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.7, ease }}>
      <span className="t-label stage__count">
        Question <span className="t-num stage__n">{pad2(index + 1)}</span> <span className="t-faint">of {pad2(total)}</span>
      </span>
      <Chip size="sm" mono tone="mute">
        {kindLabel(q.kind)}
      </Chip>
      {q.skillIds.map((id) => {
        const s = skills?.find((x) => x.id === id);
        return (
          <Chip key={id} size="sm" level={s?.level}>
            {skillName(id, skills)}
          </Chip>
        );
      })}
      {from && (
        <span className="stage__from">
          From <em>{from.company}</em> · {from.title}
        </span>
      )}
    </motion.div>
  );
}

function MicIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <rect x="7.5" y="2.5" width="5" height="9.5" rx="2.5" />
      <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />
    </svg>
  );
}

/* feedback */

function useCountUp(target: number, ms = 1100) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return n;
}

function FeedbackStage({
  session,
  index,
  skills,
  onRetry,
  onNext,
  nextLabel,
}: {
  session: InterviewSession;
  index: number;
  skills?: GapSkill[];
  onRetry: () => void;
  onNext: () => void;
  nextLabel: string;
}) {
  const q = session.questions[index];
  const turn = turnFor(session, q.id) as InterviewTurn;
  const [active, setActive] = useState<number>();
  const shown = useCountUp(turn.overall);
  const rows = CRITERIA.map((c, i) => ({ c, s: scoreFor(turn, c, i) }));
  const { runs, found } = useMemo(() => highlightRuns(turn.answer, rows.map((r) => r.s?.quote)), [turn]);

  return (
    <section className="fb" aria-label={`Feedback on question ${index + 1}`}>
      <QuestionHead question={q} index={index} total={session.questions.length} skills={skills} />

      <div className="fb__head">
        <div className="fb__score">
          <span className="t-label">Overall</span>
          <span className="fb__n t-num" aria-label={`${turn.overall} out of 100`}>
            {shown}
            <span className="fb__of">/100</span>
          </span>
          <motion.p className="fb__verdict" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease, delay: 0.5 }}>
            {verdict(turn.overall)}
          </motion.p>
        </div>
        <p className="fb__q">{q.text}</p>
      </div>

      <div className="fb__grid">
        <Card pad="lg" className="crits" label="Five criteria" aside={<span className="t-micro">1 to 5 · hover to find the quote</span>} settle={0.1}>
          <ul className="crits__list">
            {rows.map(({ c, s }, i) =>
              s ? (
                <li
                  key={c}
                  className={['crit', active === i && 'is-active'].filter(Boolean).join(' ')}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive(undefined)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(undefined)}
                  tabIndex={0}
                >
                  <div className="crit__top">
                    <span className="crit__name">{c}</span>
                    <Pips score={s.score} animate delay={0.2 + i * 0.08} />
                    <span className={['crit__score t-num', s.score <= 2 && 't-accent'].filter(Boolean).join(' ')}>
                      {s.score}
                      <span className="t-faint">/5</span>
                    </span>
                  </div>
                  <p className="crit__why">{s.why}</p>
                  {s.quote && !found[i] && <p className="crit__quote">&ldquo;{s.quote}&rdquo;</p>}
                  {s.score < 5 && active === i && <p className="crit__five t-micro">A 5 looks like: {ANCHORS[c][2]}</p>}
                </li>
              ) : null,
            )}
          </ul>
        </Card>

        <Card pad="lg" className="said" label="Your answer" aside={<span className="t-micro t-num">{wordCount(turn.answer)} words</span>} settle={0.16}>
          <p className="said__text">
            {runs.map((r, k) =>
              r.criteria.length ? (
                <mark
                  key={k}
                  className={['said__mark', active !== undefined && r.criteria.includes(active) && 'is-on'].filter(Boolean).join(' ')}
                  onMouseEnter={() => setActive(r.criteria[0])}
                  onMouseLeave={() => setActive(undefined)}
                >
                  {r.text}
                </mark>
              ) : (
                <span key={k}>{r.text}</span>
              ),
            )}
          </p>
          <p className="said__key t-micro">Underlined text shows lines quoted from your answer.</p>
        </Card>
      </div>

      <div className="fb__lists">
        <FeedbackList title="What worked" items={turn.strengths} tone="paper" empty="Nothing stood out yet. Start with the suggestions below." />
        <FeedbackList title="Fix next time" items={turn.fixes} tone="accent" empty="No fixes. Keep this shape." />
      </div>

      <Better answer={turn.answer} better={turn.betterAnswer} />

      {turn.followUp && <Probe key={q.id} line={turn.followUp} />}

      <div className="fb__nav">
        <Button variant="quiet" iconLeft="refresh" onClick={onRetry}>
          Try again
        </Button>
        <Button variant="primary" icon="arrow-right" onClick={onNext}>
          {nextLabel}
        </Button>
      </div>
    </section>
  );
}

function FeedbackList({ title, items, tone, empty }: { title: string; items: string[]; tone: 'paper' | 'accent'; empty: string }) {
  return (
    <div className={`fl fl--${tone}`}>
      <span className="t-label fl__title">{title}</span>
      {items.length ? (
        <ul>
          {items.map((t, i) => (
            <motion.li key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.6, ease, delay: 0.3 + i * 0.07 }}>
              {t}
            </motion.li>
          ))}
        </ul>
      ) : (
        <p className="fl__empty">{empty}</p>
      )}
    </div>
  );
}

function BetterText({ text }: { text: string }) {
  const paras = text.split(/\n+/).filter((p) => p.trim());
  return (
    <div className="better__text">
      {paras.map((p, i) => (
        <p key={i}>
          {placeholderParts(p).map((x, j) =>
            x.hole ? (
              <span key={j} className="hole t-mono" title="Missing detail. Fill this in with your own facts.">
                {x.part.slice(1, -1)}
              </span>
            ) : (
              <span key={j}>{x.part}</span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

function Better({ answer, better }: { answer: string; better: string }) {
  const [mode, setMode] = useState<'better' | 'compare'>('better');
  const holes = placeholderParts(better).some((x) => x.hole);
  return (
    <Card pad="lg" className="better" settle={0.2}>
      <div className="better__head">
        <div className="better__titles">
          <span className="t-label">Rewritten with your own details</span>
          <h3 className="better__title">A stronger version of your answer</h3>
        </div>
        <Tabs
          size="sm"
          aria-label="Compare"
          items={[
            { id: 'better', label: 'Stronger' },
            { id: 'compare', label: 'Side by side' },
          ]}
          value={mode}
          onChange={(v) => setMode(v)}
        />
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {mode === 'better' ? (
          <motion.div key="b" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35, ease }}>
            <BetterText text={better} />
          </motion.div>
        ) : (
          <motion.div key="c" className="better__compare" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35, ease }}>
            <div className="better__col">
              <span className="t-label">Yours · {wordCount(answer)} words</span>
              <div className="better__text better__text--mine">
                {answer
                  .split(/\n+/)
                  .filter((p) => p.trim())
                  .map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
              </div>
            </div>
            <div className="better__col">
              <span className="t-label">Stronger · {wordCount(better)} words</span>
              <BetterText text={better} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {holes && <p className="better__note t-micro">Bracketed parts are details you did not mention. Fill them in with your own facts; Tack does not invent numbers.</p>}
    </Card>
  );
}

function Probe({ line }: { line: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  return (
    <motion.div className="probe" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease, delay: 0.3 }}>
      <div className="probe__who">
        <span className="probe__dot" aria-hidden="true" />
        <span className="t-label">The interviewer follows up</span>
      </div>
      <p className="probe__line">&ldquo;{line}&rdquo;</p>
      {open ? (
        <div className="probe__practice">
          <textarea
            className="probe__input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            autoFocus
            placeholder="Answer it in three or four sentences."
            aria-label="Practice answer to the follow-up"
          />
          <div className="probe__foot">
            <span className="t-micro">{wordCount(text)} words · practice only, follow-ups are not scored</span>
            <Button variant="quiet" size="sm" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" size="sm" iconLeft="plus" onClick={() => setOpen(true)}>
          {text.trim() ? 'Keep practising' : 'Answer for practice'}
        </Button>
      )}
    </motion.div>
  );
}

/* summary */

function SummaryStage({
  session,
  sessions,
  skills,
  onGo,
  onLeave,
}: {
  session: InterviewSession;
  sessions: InterviewSession[];
  skills?: GapSkill[];
  onGo: (v: View) => void;
  onLeave: () => void;
}) {
  const score = sessionScore(session) ?? 0;
  const shown = useCountUp(score);
  const prev = sessions
    .filter((s) => s.id !== session.id && s.startedAt < session.startedAt && s.turns.length)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const delta = prev ? score - (sessionScore(prev) ?? 0) : undefined;
  const avgs = criterionAverages(session.turns);
  const weakest = [...avgs].filter((a) => a.n).sort((a, b) => a.avg - b.avg)[0];
  const strongest = [...avgs].filter((a) => a.n).sort((a, b) => b.avg - a.avg)[0];
  const moves = skillResults(session);
  const moved = moves.filter((m) => m.moved);

  return (
    <section className="sum" aria-label="Session summary">
      <Card pad="lg" className="sum__top" settle>
        <div className="sum__score">
          <span className="t-label">Session score</span>
          <span className="sum__n t-num">
            {shown}
            <span className="fb__of">/100</span>
          </span>
          {delta !== undefined && (
            <span className="sum__delta t-num">
              {delta >= 0 ? '+' : ''}
              {delta} on your last session
            </span>
          )}
          <span className="t-micro">
            {kindLabel(session.kind)} · {shortDate(session.startedAt)} · {session.turns.length} of {session.questions.length} answered
          </span>
        </div>
        <div className="sum__crit">
          <span className="t-label">Average by category</span>
          <ul>
            {avgs.map((a, i) => {
              const weak = weakest && a.criterion === weakest.criterion && a.n > 0;
              return (
                <li key={a.criterion} className={weak ? 'is-weak' : undefined}>
                  <span className="sum__crit-name">{a.criterion}</span>
                  <span className="sum__track">
                    <motion.span
                      className="sum__fill"
                      initial={{ scaleX: 0 }}
                      animate={{ scaleX: a.avg / 5 }}
                      transition={{ duration: 1.1, ease, delay: 0.25 + i * 0.07 }}
                    />
                  </span>
                  <span className="t-num sum__avg">{a.n ? a.avg.toFixed(1) : '–'}</span>
                </li>
              );
            })}
          </ul>
          {weakest && (
            <div className="sum__weak">
              <span className="t-label t-accent">Weakest · {weakest.criterion}</span>
              <p>
                Averaged {weakest.avg.toFixed(1)} of 5
                {strongest && strongest.criterion !== weakest.criterion ? `, against ${strongest.avg.toFixed(1)} for ${strongest.criterion.toLowerCase()}` : ''}. A 5
                looks like this: {ANCHORS[weakest.criterion][2].charAt(0).toLowerCase() + ANCHORS[weakest.criterion][2].slice(1)}
              </p>
            </div>
          )}
        </div>
      </Card>

      <div className="sum__grid">
        <Card pad="md" label="Question by question" settle={0.08}>
          <ul className="sum__qs">
            {session.questions.map((q, i) => {
              const t = turnFor(session, q.id);
              return (
                <li key={q.id}>
                  <button type="button" className="sum__q" onClick={() => onGo(t ? { at: 'feedback', i } : { at: 'question', i })}>
                    <span className="t-num sum__qn">Q{i + 1}</span>
                    <span className="sum__qtext">{q.text}</span>
                    <span className={['t-num sum__qs-score', !t && 't-faint'].filter(Boolean).join(' ')}>{t ? t.overall : 'Answer'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
        <Card pad="md" label="Skills tested" settle={0.14}>
          {moves.length ? (
            <ul className="sum__skills">
              {moves.map((m) => (
                <li key={m.id}>
                  <span className="sum__skill">{skillName(m.id, skills)}</span>
                  <span className="t-num sum__skill-avg">{m.avg.toFixed(1)}</span>
                  <span className={['sum__moved t-micro', m.moved && 'is-up'].filter(Boolean).join(' ')}>
                    {m.moved ? (
                      <>
                        <Icon name="arrow-up-right" size={12} /> Raised a level
                      </>
                    ) : (
                      'Held'
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sum__none">No skills were tagged for these questions.</p>
          )}
          <p className="sum__rule t-micro">A skill moves up one level on the gap map when its questions average above 4 of 5.</p>
        </Card>
      </div>

      <div className="sum__next">
        <p className="sum__line">
          {score < 50
            ? 'Under 50, so the next replan adds practice blocks aimed at the weakest criterion.'
            : moved.length
              ? `${moved.length === 1 ? 'One skill' : `${moved.length} skills`} moved up on the gap map. The plan picks that up at the next replan.`
              : 'No skill reached 4 of 5 this time. Your practice plan stays as it is.'}
        </p>
        <div className="sum__buttons">
          <Button variant="primary" icon="arrow-right" to="/plan">
            Open the plan
          </Button>
          <Button variant="ghost" to="/gap">
            Gap map
          </Button>
          <Button variant="quiet" iconLeft="plus" onClick={onLeave}>
            New session
          </Button>
        </div>
      </div>
    </section>
  );
}
