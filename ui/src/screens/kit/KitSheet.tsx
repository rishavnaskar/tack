import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { useLatestTrace } from '../../api/events';
import { actions, useApplications, useGap, useKit, usePostings } from '../../api/hooks';
import { applying, isActive, useRunFor } from '../../api/applying';
import { api } from '../../api/client';
import { useQuery } from '../../api/query';
import { useCan } from '../../api/capabilities';
import { RunCard } from '../tracker/ApplyRuns';
import type { GapSkill, Kit } from '../../api/types';
import { hostOf, pad2 } from '../../lib/format';
import { BlueprintLoader, Button, Drawer, ErrorState, LevelGlyph, Meter, ease, useToast } from '../../ui';
import './KitSheet.css';

export interface KitTarget {
  postingId: string;
  title: string;
  company: string;
  url: string;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API is blocked on plain http and in some webviews
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

const bulletLines = (kit: Kit) => kit.bullets.map((b) => `- ${b.text}`).join('\n');

export function kitAsText(kit: Kit, t: KitTarget): string {
  return [
    `${t.title} at ${t.company}`,
    t.url,
    '',
    'Headline',
    kit.headline,
    '',
    'Résumé bullets',
    bulletLines(kit),
    '',
    'Cover note',
    kit.coverNote,
    '',
    'Talking points',
    ...kit.talkingPoints.map((x) => `- ${x}`),
    ...(kit.gapsToAddress.length ? ['', 'Gaps to address', ...kit.gapsToAddress.map((g) => `- ${g.skill}: ${g.howToFrame}`)] : []),
    '',
    'Questions to ask',
    ...kit.questionsToAsk.map((q) => `- ${q}`),
  ].join('\n');
}

function CopyButton({ text, label = 'Copy', what }: { text: string; label?: string; what: string }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1800);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <Button
      variant="quiet"
      size="sm"
      iconLeft={done ? 'check' : 'file'}
      onClick={async () => {
        if (await copyText(text)) setDone(true);
        else toast({ title: 'Could not copy', body: `Select the ${what} and copy it manually.`, tone: 'error' });
      }}
      aria-label={`${label}: ${what}`}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

function Head({ index, label, count, aside }: { index: string; label: string; count?: number; aside?: ReactNode }) {
  return (
    <div className="kit__head">
      <span className="t-label">
        <span className="t-accent">{index}</span> {label}
        {count !== undefined && <span className="t-num t-faint"> {count}</span>}
      </span>
      {aside}
    </div>
  );
}

export function KitSheet({ target, onClose }: { target?: KitTarget; onClose: () => void }) {
  const last = useRef(target);
  if (target) last.current = target;
  const t = target ?? last.current;
  const kit = useKit(t?.postingId);
  const apps = useApplications();
  const postings = usePostings();
  const opened = useRef({ id: '', at: 0 });
  if (target && opened.current.id !== target.postingId) opened.current = { id: target.postingId, at: Date.now() - 500 };
  const [rewroteAt, setRewroteAt] = useState(0);
  const [marking, setMarking] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const toast = useToast();

  const applied = !!t && (apps.data ?? []).some((a) => a.postingId === t.postingId);
  const data = kit.data;
  const run = useRunFor(t?.postingId);
  const canApply = useCan('apply');
  const ready = useQuery(`apply-readiness:${t?.postingId ?? ''}`, () => api.readiness(t?.postingId), { enabled: !!t && canApply === true });
  const [starting, setStarting] = useState(false);

  const apply = async () => {
    if (!t) return;
    setStarting(true);
    try {
      const res = await applying.start([t.postingId]);
      toast({ title: res.note, body: ready.data?.target === 'practice' ? "Opens in a Chrome window and goes to Tack's practice form, never the company." : 'Opens in a Chrome window and submits automatically without a review step.' });
    } catch (e) {
      toast({ title: 'Could not start applying', body: (e as Error).message, tone: 'error' });
    } finally {
      setStarting(false);
    }
  };
  const blocked = ready.data && !ready.data.ready ? ready.data.reason : undefined;

  const mark = async () => {
    if (!t) return;
    setMarking(true);
    const p = postings.data?.find((x) => x.id === t.postingId);
    try {
      await actions.addApplication({
        postingId: t.postingId,
        title: t.title,
        company: t.company,
        url: t.url,
        ...(data ? { fit: data.fit } : {}),
        ...(p?.roleFamily ? { roleFamily: p.roleFamily } : {}),
        ...(p?.seniority ? { seniority: p.seniority } : {}),
        ...(p?.companySize ? { companySize: p.companySize } : {}),
        ...(p?.source ? { source: p.source } : {}),
      });
      toast({ title: `${t.company} is in Applied`, body: 'The tracker counts it from now on.', tone: 'success' });
    } catch (e) {
      toast({ title: 'Could not save it', body: (e as Error).message, tone: 'error' });
    } finally {
      setMarking(false);
    }
  };

  const rewrite = async () => {
    if (!t) return;
    setRewroteAt(Date.now() - 500);
    setRewriting(true);
    try {
      await actions.rebuildKit(t.postingId);
    } catch (e) {
      toast({ title: 'Could not rewrite the kit', body: (e as Error).message, tone: 'error' });
    } finally {
      setRewriting(false);
    }
  };

  const copyAll = async () => {
    if (!data || !t) return;
    const ok = await copyText(kitAsText(data, t));
    toast(ok ? { title: 'Kit copied', body: 'Headline, bullets, cover note, talking points, gaps, and questions.', tone: 'success' } : { title: 'Could not copy', tone: 'error' });
  };

  const busy = kit.loading || rewriting;

  return (
    <Drawer
      open={!!target}
      onClose={onClose}
      width={920}
      eyebrow={t ? <span className="kit__eyebrow">Application kit</span> : undefined}
      title={t?.title ?? ''}
      actions={
        data && !busy ? (
          <Button variant="quiet" size="sm" iconLeft="refresh" onClick={rewrite}>
            Rewrite
          </Button>
        ) : undefined
      }
      footer={
        t ? (
          <div className="kit__foot">
            <Button variant="ghost" iconLeft="file" onClick={copyAll} disabled={!data || busy}>
              Copy all
            </Button>
            <Button variant="ghost" icon="arrow-up-right" href={t.url} target="_blank">
              Open posting
            </Button>
            <Button variant={canApply === false ? 'primary' : 'ghost'} iconLeft="check" onClick={mark} loading={marking} disabled={applied}>
              {applied ? 'Applied' : 'Mark applied'}
            </Button>
            {canApply !== false && (
              <Button
                variant="primary"
                icon="arrow-right"
                onClick={apply}
                loading={starting || (!!run && isActive(run))}
                disabled={applied || run?.status === 'applied' || !!blocked}
                title={blocked}
              >
                {ready.data?.target === 'practice' ? 'Apply (practice)' : 'Apply'}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      {t && (run || blocked) && (
        <div className="kit__run">
          {run ? <RunCard run={run} /> : <p className="kit__blocked t-mute">{blocked}</p>}
        </div>
      )}
      {t && canApply === false && (
        <div className="kit__run">
          <p className="kit__blocked t-mute">Auto-apply runs in the desktop app. Copy the kit, apply on the company site, then mark it applied.</p>
        </div>
      )}
      {t &&
        (busy ? (
          <KitLoading since={Math.max(opened.current.at, rewroteAt)} />
        ) : kit.error && !data ? (
          <ErrorState title="Could not prepare the kit" message={kit.error.message} onRetry={() => kit.refetch().catch(() => undefined)} />
        ) : data ? (
          <KitBody kit={data} target={t} />
        ) : null)}
    </Drawer>
  );
}

function KitLoading({ since }: { since: number }) {
  const latest = useLatestTrace(since);
  const step = latest?.run === 'kit' ? latest.step : '';
  const stage = step === 'guard' || step === 'done' ? 2 : step === 'draft' ? 1 : 0;
  return (
    <BlueprintLoader
      label="Preparing your application"
      detail={latest ? `${latest.step} · ${latest.detail}` : 'Comparing the job post to your résumé'}
      stages={['Read the job post', 'Tailor to your résumé', 'Check every line']}
      stage={stage}
      height={300}
    />
  );
}

function KitBody({ kit, target }: { kit: Kit; target: KitTarget }) {
  const gap = useGap();
  const byName = new Map<string, GapSkill>((gap.data?.skills ?? []).map((s) => [s.name.toLowerCase(), s]));
  const rise = (i: number) => ({
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.7, ease, delay: 0.05 + i * 0.06 },
  });

  return (
    <div className="kit">
      <motion.div className="kit__top" {...rise(0)}>
        <div className="kit__meta">
          <span>{target.company}</span>
          <span className="t-mono">{hostOf(target.url)}</span>
        </div>
        <div className="kit__fit">
          <Meter value={kit.fit} size="sm" label="Fit against your résumé" valueLabel={<span className="t-num kit__fit-n">{kit.fit}</span>} />
        </div>
      </motion.div>

      <motion.section className="kit__sec" {...rise(1)}>
        <Head index="01" label="Headline" />
        <p className="kit__headline">{kit.headline}</p>
      </motion.section>

      <motion.section className="kit__sec" {...rise(2)}>
        <Head index="02" label="Résumé bullets" count={kit.bullets.length} aside={<CopyButton text={bulletLines(kit)} what="bullets" />} />
        <p className="kit__lede">Every bullet comes from your résumé. Tack removes anything it cannot verify.</p>
        <ol className="kit__bullets">
          {kit.bullets.map((b, i) => (
            <li key={`${i}-${b.basedOn}`}>
              <span className="t-num kit__n">{pad2(i + 1)}</span>
              <div className="kit__bullet">
                <p>{b.text}</p>
                <p className="kit__src">
                  <span className="t-label">From your résumé</span>
                  {b.basedOn === b.text ? <span className="kit__verbatim">word for word</span> : <span className="kit__quote">&ldquo;{b.basedOn}&rdquo;</span>}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </motion.section>

      <motion.section className="kit__sec" {...rise(3)}>
        <Head index="03" label="Cover note" aside={<CopyButton text={kit.coverNote} what="cover note" />} />
        <div className="kit__letter">{kit.coverNote}</div>
      </motion.section>

      <motion.section className="kit__sec" {...rise(4)}>
        <Head index="04" label="Talking points" count={kit.talkingPoints.length} />
        <ol className="kit__list">
          {kit.talkingPoints.map((x, i) => (
            <li key={i}>
              <span className="t-num kit__n">{pad2(i + 1)}</span>
              <p>{x}</p>
            </li>
          ))}
        </ol>
      </motion.section>

      <div className="kit__pair">
        <motion.section className="kit__sec" {...rise(5)}>
          <Head index="05" label="Gaps to address" count={kit.gapsToAddress.length} />
          {kit.gapsToAddress.length ? (
            <ul className="kit__gaps">
              {kit.gapsToAddress.map((g) => {
                const s = byName.get(g.skill.toLowerCase());
                return (
                  <li key={g.skill}>
                    <span className="kit__gap-name">
                      {s && <LevelGlyph level={s.level} size={10} />}
                      {g.skill}
                    </span>
                    <p>{g.howToFrame}</p>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="kit__lede">Your résumé covers everything this job asks for.</p>
          )}
        </motion.section>

        <motion.section className="kit__sec" {...rise(6)}>
          <Head index="06" label="Questions to ask" count={kit.questionsToAsk.length} />
          <ul className="kit__questions">
            {kit.questionsToAsk.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </motion.section>
      </div>
    </div>
  );
}
