import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { api } from '../../api/client';
import { actions } from '../../api/hooks';
import { useQuery } from '../../api/query';
import { useCan } from '../../api/capabilities';
import type { MailKind, SyncResult } from '../../api/types';
import { agoShort } from '../../lib/format';
import { Button, Card, Icon, ease, useToast } from '../../ui';
import { STATUS_LABEL } from './model';
import './Mail.css';

const KIND_LABEL: Record<MailKind, [string, string]> = {
  interview: ['interview', 'interviews'], reply: ['reply', 'replies'], rejected: ['rejection', 'rejections'], offer: ['offer', 'offers'],
  'auto-ack': ['automatic acknowledgement', 'automatic acknowledgements'], unrelated: ['unrelated', 'unrelated'],
};

const POLL_MS = 3000;
const POLL_FOR_MS = 5 * 60_000;

export function MailStrip({ onResult }: { onResult: (r: SyncResult) => void }) {
  const can = useCan('mail');
  if (can === undefined) return null;
  if (!can) {
    return (
      <div className="mail is-off" role="region" aria-label="Mail">
        <span className="t-label mail__label">Mail</span>
        <span className="mail__state">
          <span className="mail__dot" aria-hidden="true" />
          Runs in the desktop app
        </span>
        <span className="mail__note">Reading replies from your mail needs the desktop app. Here, move a card when a company writes back.</span>
      </div>
    );
  }
  return <LiveMailStrip onResult={onResult} />;
}

function LiveMailStrip({ onResult }: { onResult: (r: SyncResult) => void }) {
  const status = useQuery('mail-status', api.mailStatus);
  const [checking, setChecking] = useState(false);
  const [connecting, setConnecting] = useState<'idle' | 'starting' | 'waiting'>('idle');
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  const toast = useToast();
  const s = status.data;

  // While Google's window is open, look every few seconds whether the connection has landed.
  useEffect(() => {
    if (connecting !== 'waiting') return;
    const until = Date.now() + POLL_FOR_MS;
    let stop = false;
    const look = async () => {
      if (stop) return;
      try {
        const next = await api.mailCheck();
        if (next.connected) {
          setConnecting('idle');
          setLink(undefined);
          await status.refetch().catch(() => undefined);
          toast({ title: 'Gmail is connected', body: 'Replies are read on their own every few hours, read-only.', tone: 'success' });
          return;
        }
      } catch (e) {
        setError((e as Error).message);
      }
      if (Date.now() > until) {
        setConnecting('idle');
        setError('Google did not finish within five minutes. Connect again when you are ready.');
        return;
      }
      window.setTimeout(look, POLL_MS);
    };
    const t = window.setTimeout(look, POLL_MS);
    return () => { stop = true; window.clearTimeout(t); };
  }, [connecting]);

  const check = async () => {
    setChecking(true);
    try {
      onResult(await actions.syncApplications());
    } catch (e) {
      toast({ title: 'Could not check replies', body: (e as Error).message, tone: 'error' });
    } finally {
      setChecking(false);
    }
  };

  const connect = async () => {
    setConnecting('starting');
    setError(undefined);
    try {
      const { url, opened } = await api.mailConnect(true);
      // The coach opens the default browser; when it cannot, the link opens here instead.
      if (!opened) window.open(url, '_blank', 'noopener');
      setLink(url);
      setConnecting('waiting');
    } catch (e) {
      setConnecting('idle');
      setError((e as Error).message);
    }
  };

  const disconnect = async () => {
    setLeaving(true);
    setError(undefined);
    try {
      const next = await api.mailDisconnect();
      await status.refetch().catch(() => undefined);
      toast({ title: 'Gmail is disconnected', body: next.note });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLeaving(false);
    }
  };

  const tone = !s ? 'is-loading' : s.source === 'sample' ? 'is-sample' : s.connected ? 'is-on' : 'is-off';
  const note = connecting === 'waiting' ? 'Finish in the Google window that opened. This page notices by itself when it is done.' : s?.note ?? status.error?.message ?? '';

  return (
    <div className={['mail', tone].join(' ')} role="region" aria-label="Mail">
      <span className="t-label mail__label">Mail</span>
      <span className="mail__state">
        {connecting === 'waiting' ? <span className="pulse-dot" aria-hidden="true" /> : <span className="mail__dot" aria-hidden="true" />}
        {connecting === 'waiting' ? 'Waiting for Google' : s ? s.label : status.error ? 'Mail status unavailable' : 'Checking mail'}
      </span>
      <span className="mail__note">
        {note}
        {connecting === 'waiting' && link && (
          <>
            {' '}
            <a href={link} target="_blank" rel="noreferrer">Open Google's page again</a>
          </>
        )}
        {error && (
          <span className="mail__error" role="alert">
            {error}
          </span>
        )}
      </span>
      <span className="mail__acts">
        {s?.canConnect && connecting !== 'waiting' && (
          <Button variant="ghost" size="sm" iconLeft="plus" onClick={connect} loading={connecting === 'starting'}>
            Connect Gmail
          </Button>
        )}
        {connecting === 'waiting' && (
          <Button variant="quiet" size="sm" onClick={() => setConnecting('idle')}>
            Cancel
          </Button>
        )}
        {s?.canDisconnect && (
          <Button variant="quiet" size="sm" onClick={disconnect} loading={leaving}>
            Disconnect
          </Button>
        )}
        <Button variant="primary" size="sm" iconLeft="refresh" onClick={check} loading={checking} disabled={!s?.connected}>
          Check replies
        </Button>
      </span>
    </div>
  );
}

export function WhatChanged({ result, onClose }: { result: SyncResult; onClose: () => void }) {
  const counts = Object.entries(result.classified).filter(([, n]) => n) as [MailKind, number][];
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease }}>
      <Card
        pad="lg"
        className="changed"
        label="What changed"
        aside={
          <Button variant="quiet" size="sm" iconLeft="close" onClick={onClose}>
            Close
          </Button>
        }
      >
        <p className="changed__summary">
          {result.source === 'sample' && <span className="origin origin--demo">sample mailbox</span>}
          {result.note}
        </p>
        {counts.length > 0 && (
          <p className="changed__counts t-mono">
            {counts.map(([k, n]) => `${n} ${KIND_LABEL[k][n === 1 ? 0 : 1]}`).join(' · ')}
            <span className="t-faint"> · sorted by {result.by === 'model' ? 'the model' : 'keyword rules'} · {(result.ms / 1000).toFixed(1)} s</span>
          </p>
        )}
        {result.changes.length === 0 ? (
          <p className="t-mute">No application changed status. Automatic acknowledgements never count as a reply.</p>
        ) : (
          <ol className="changed__list">
            {result.changes.map((c, i) => (
              <motion.li key={`${c.applicationId}-${c.at}`} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.5, ease, delay: 0.1 + i * 0.06 }}>
                <div className="changed__top">
                  <span className="changed__company">{c.company}</span>
                  <span className="changed__move t-mono">
                    <span className={`st st--${c.from}`}>{STATUS_LABEL[c.from]}</span>
                    <Icon name="arrow-right" size={13} />
                    <span className={`st st--${c.to}`}>{STATUS_LABEL[c.to]}</span>
                  </span>
                </div>
                <p className="changed__subject">{c.subject}</p>
                <p className="changed__from t-faint">
                  {c.sender} · {agoShort(c.at)}
                </p>
              </motion.li>
            ))}
          </ol>
        )}
      </Card>
    </motion.div>
  );
}
