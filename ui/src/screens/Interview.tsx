import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { motion } from 'motion/react';
import { actions, keys, useAppState, useInterviews, usePostings } from '../api/hooks';
import { invalidate } from '../api/query';
import type { InterviewSession, Posting } from '../api/types';
import { pad2, shortDate } from '../lib/format';
import { BlueprintLoader, Button, Card, Chip, EmptyState, ErrorState, Icon, PageHeader, Skeleton, ease, useToast } from '../ui';
import { ANCHORS, CRITERIA, KINDS, criterionAverages, isDone, kindLabel, postingLabel, sessionScore, type SessionKind } from './interview/model';
import { Pips, Trend, useLatestSince } from './interview/parts';
import { SessionRoom } from './interview/Room';
import './Interview.css';

export function Interview() {
  const [params, setParams] = useSearchParams();
  const interviews = useInterviews();
  const postings = usePostings();
  const { data: state } = useAppState();
  const sessionId = params.get('session');

  const sessions = useMemo(() => [...(interviews.data ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt)), [interviews.data]);
  const active = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;

  const open = (id?: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('session', id);
    else next.delete('session');
    setParams(next);
    window.scrollTo({ top: 0 });
  };

  if (sessionId && active) {
    return <SessionRoom key={active.id} session={active} sessions={sessions} postings={postings.data} onLeave={() => open()} />;
  }

  const hasProfile = !!state?.profile;

  return (
    <div className="iv">
      <PageHeader
        index="05"
        section="Interview"
        title="Practise the questions they will ask"
        purpose="One question at a time, from your target postings and open gaps. Each answer is scored on five criteria, with a stronger version built only from what you said."
        actions={
          sessions.length ? (
            <Chip mono size="sm" tone="mute">
              {sessions.length} session{sessions.length === 1 ? '' : 's'}
            </Chip>
          ) : undefined
        }
      />

      {interviews.error && !interviews.data ? (
        <ErrorState title="Could not load interview sessions" message={interviews.error.message} onRetry={() => interviews.refetch().catch(() => undefined)} />
      ) : interviews.loading || (sessionId && !interviews.data) ? (
        <LobbySkeleton />
      ) : !hasProfile && state ? (
        <EmptyState
          eyebrow="No profile yet"
          title="Questions come from your target and your gaps"
          body="Add a résumé and a target role on the start screen, or load the demo person, and the questions will be written for that move."
          action={
            <Button variant="primary" icon="arrow-right" to="/">
              Go to Start
            </Button>
          }
        />
      ) : (
        <>
          {sessionId && !active && (
            <div className="iv__lost">
              <ErrorState compact title="That session is gone" message="It may have been cleared with a reset. Start a new one below." />
            </div>
          )}
          <div className="lobby">
            <SetupCard postings={postings.data ?? []} postingsLoading={postings.loading} onStarted={(s) => open(s.id)} />
            <History sessions={sessions} postings={postings.data} onOpen={open} />
          </div>
          <RubricTable />
        </>
      )}
    </div>
  );
}

/* setup */

function SetupCard({ postings, postingsLoading, onStarted }: { postings: Posting[]; postingsLoading: boolean; onStarted: (s: InterviewSession) => void }) {
  const [kind, setKind] = useState<SessionKind>('mixed');
  const [postingId, setPostingId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [since, setSince] = useState(0);
  const latest = useLatestSince(since);
  const toast = useToast();

  const start = async () => {
    setErr(undefined);
    setBusy(true);
    setSince(Date.now());
    try {
      const s = await actions.startInterview(kind, postingId);
      invalidate(keys.state);
      onStarted(s);
    } catch (e) {
      setErr((e as Error).message);
      toast({ title: 'Could not start the session', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const picked = postings.find((p) => p.id === postingId);

  return (
    <Card pad="lg" className="setup" settle>
      {busy ? (
        <BlueprintLoader
          height={300}
          label={picked ? `Writing questions for ${picked.company}` : 'Writing five questions'}
          detail={latest ? `${latest.step} · ${latest.detail}` : 'Reading your target postings and open gaps'}
        />
      ) : (
        <>
          <div className="setup__head">
            <span className="t-label">
              <span className="t-accent">New</span> <span className="t-faint">/</span> Session
            </span>
            <span className="t-micro">Five questions · about 20 minutes</span>
          </div>

          <div className="kinds" role="radiogroup" aria-label="Session kind">
            {KINDS.map((k, i) => {
              const on = k.id === kind;
              return (
                <motion.button
                  key={k.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={['kind', on && 'is-on'].filter(Boolean).join(' ')}
                  onClick={() => setKind(k.id)}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.7, ease, delay: 0.1 + i * 0.05 }}
                >
                  <span className="kind__top">
                    <span className="kind__index t-num">{pad2(i + 1)}</span>
                    <span className="kind__radio" aria-hidden="true" />
                  </span>
                  <span className="kind__name">{k.label}</span>
                  <span className="kind__line">{k.line}</span>
                  <span className="kind__mix t-micro">{k.mix}</span>
                </motion.button>
              );
            })}
          </div>

          <PostingPicker postings={postings} loading={postingsLoading} value={postingId} onChange={setPostingId} />

          <div className="setup__foot">
            <p className="setup__note">
              {picked ? (
                <>
                  Questions lean on <em className="setup__em">{picked.company}</em>&rsquo;s posting and the skills it asks for.
                </>
              ) : (
                'Questions are drawn from all your target postings and the gaps with the highest priority.'
              )}
            </p>
            {err && <span className="setup__err t-mono">{err}</span>}
            <Button variant="primary" size="lg" icon="arrow-right" onClick={start}>
              Start the session
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function PostingPicker({ postings, loading, value, onChange }: { postings: Posting[]; loading: boolean; value?: string; onChange: (id?: string) => void }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hits = needle ? postings.filter((p) => `${p.company} ${p.title}`.toLowerCase().includes(needle)) : postings;
    return [...hits].sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0));
  }, [postings, q]);
  const picked = postings.find((p) => p.id === value);
  const shown = list.filter((p) => p.id !== value).slice(0, picked ? 3 : 4);

  return (
    <div className="against">
      <div className="against__head">
        <span className="t-label">
          Against one posting <span className="t-faint">· optional</span>
        </span>
        {picked && (
          <button type="button" className="against__clear t-micro" onClick={() => onChange(undefined)}>
            Any posting
          </button>
        )}
      </div>
      {loading ? (
        <Skeleton height={46} radius={10} />
      ) : !postings.length ? (
        <p className="against__none">No postings read yet. Read the market to practise against a specific one.</p>
      ) : (
        <>
          <label className="search">
            <Icon name="search" size={16} />
            <input
              className="search__input"
              type="search"
              value={q}
              placeholder={`Search ${postings.length} postings by company or title`}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search postings"
            />
          </label>
          <ul className="against__list">
            {picked && (
              <li>
                <PostingRow posting={picked} on onClick={() => onChange(undefined)} />
              </li>
            )}
            {shown.map((p) => (
              <li key={p.id}>
                <PostingRow posting={p} onClick={() => onChange(p.id)} />
              </li>
            ))}
            {!shown.length && !picked && <li className="against__none">No posting matches &ldquo;{q}&rdquo;.</li>}
          </ul>
        </>
      )}
    </div>
  );
}

function PostingRow({ posting: p, on, onClick }: { posting: Posting; on?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={['prow', on && 'is-on'].filter(Boolean).join(' ')} onClick={onClick} aria-pressed={!!on}>
      <span className="prow__mark" aria-hidden="true">
        {on && <Icon name="check" size={13} strokeWidth={2} />}
      </span>
      <span className="prow__text">
        <span className="prow__company">{p.company}</span>
        <span className="prow__title">{p.title}</span>
      </span>
      {p.fit !== undefined && (
        <span className="prow__fit t-num" title="Fit against your résumé">
          {p.fit}
        </span>
      )}
    </button>
  );
}

/* history */

function History({ sessions, postings, onOpen }: { sessions: InterviewSession[]; postings?: Posting[]; onOpen: (id: string) => void }) {
  const scored = [...sessions]
    .filter((s) => sessionScore(s) !== undefined && s.turns.length > 0)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const values = scored.map((s) => sessionScore(s)!);
  const last = values[values.length - 1];
  const prev = values[values.length - 2];

  return (
    <Card pad="lg" className="history" settle={0.08}>
      <div className="history__head">
        <span className="t-label">Past sessions</span>
        {values.length > 1 && last !== undefined && prev !== undefined && (
          <span className="t-micro">
            {last - prev >= 0 ? '+' : ''}
            {last - prev} on the one before
          </span>
        )}
      </div>

      {sessions.length === 0 ? (
        <div className="history__empty">
          <Trend values={[]} />
          <p>No sessions yet. Your first score starts the line.</p>
        </div>
      ) : (
        <>
          <Trend values={values} labels={scored.map((s) => shortDate(s.startedAt))} />
          <ul className="past-list">
            {sessions.map((s, i) => {
              const score = sessionScore(s);
              const done = isDone(s);
              const posting = postingLabel(postings, s.postingId);
              return (
                <motion.li key={s.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, ease, delay: 0.2 + Math.min(i, 8) * 0.04 }}>
                  <button type="button" className="past" onClick={() => onOpen(s.id)}>
                    <span className={['past__score t-num', !s.turns.length && 'is-blank'].filter(Boolean).join(' ')}>
                      {s.turns.length && score !== undefined ? score : '–'}
                    </span>
                    <span className="past__body">
                      <span className="past__kind">
                        {kindLabel(s.kind)}
                        {posting && <span className="t-faint"> · {posting.company}</span>}
                      </span>
                      <span className="t-micro">
                        {shortDate(s.startedAt)} · {s.turns.length} of {s.questions.length} answered
                      </span>
                    </span>
                    <span className={['past__go t-micro', !done && 'is-open'].filter(Boolean).join(' ')}>
                      {done ? 'Review' : 'Resume'}
                      <Icon name="arrow-right" size={13} />
                    </span>
                  </button>
                </motion.li>
              );
            })}
          </ul>
          <AcrossAll sessions={sessions} />
        </>
      )}
    </Card>
  );
}

function AcrossAll({ sessions }: { sessions: InterviewSession[] }) {
  const turns = sessions.flatMap((s) => s.turns);
  if (!turns.length) return null;
  const avgs = criterionAverages(turns);
  const weakest = [...avgs].filter((a) => a.n).sort((a, b) => a.avg - b.avg)[0];
  return (
    <div className="across">
      <div className="history__head">
        <span className="t-label">Across every answer</span>
        <span className="t-micro">
          {turns.length} answer{turns.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul>
        {avgs.map((a, i) => (
          <li key={a.criterion} className={weakest?.criterion === a.criterion ? 'is-weak' : undefined}>
            <span className="across__name">{a.criterion}</span>
            <span className="across__track">
              <motion.span className="across__fill" initial={{ scaleX: 0 }} animate={{ scaleX: a.avg / 5 }} transition={{ duration: 1, ease, delay: 0.4 + i * 0.06 }} />
            </span>
            <span className="t-num across__n">{a.n ? a.avg.toFixed(1) : '–'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* rubric */

function RubricTable() {
  return (
    <section className="rubric" aria-labelledby="rubric-title">
      <div className="rubric__head">
        <div className="section__title">
          <span className="t-label section__index">
            <b>Rubric</b>
            <span className="rubric__rule" />
          </span>
          <h2 id="rubric-title">How answers are scored</h2>
          <p>Every answer gets 1 to 5 on each criterion, with the reason and the line from your answer that earned it. Overall is the mean, out of 100.</p>
        </div>
      </div>
      <div className="rubric__grid" role="table" aria-label="Scoring rubric">
        <div className="rubric__row rubric__row--head" role="row">
          <span role="columnheader" className="t-label">
            Criterion
          </span>
          {[1, 3, 5].map((n) => (
            <span role="columnheader" key={n} className="rubric__level t-label">
              <Pips score={n} size="sm" />
              Scores {n}
            </span>
          ))}
        </div>
        {CRITERIA.map((c, i) => (
          <motion.div
            key={c}
            className="rubric__row"
            role="row"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease, delay: 0.3 + i * 0.05 }}
          >
            <span role="rowheader" className="rubric__crit">
              <span className="t-num rubric__n">{pad2(i + 1)}</span>
              {c}
            </span>
            {ANCHORS[c].map((a, j) => (
              <span role="cell" key={j} className="rubric__cell" data-level={[1, 3, 5][j]}>
                {a}
              </span>
            ))}
          </motion.div>
        ))}
      </div>
    </section>
  );
}

function LobbySkeleton() {
  return (
    <div className="lobby" aria-busy="true">
      <Skeleton height={520} radius={16} />
      <Skeleton height={520} radius={16} />
    </div>
  );
}
