import { useState } from 'react';
import { motion } from 'motion/react';
import { api } from '../../api/client';
import { actions } from '../../api/hooks';
import { useQuery } from '../../api/query';
import type { MailKind, SyncResult } from '../../api/types';
import { agoShort } from '../../lib/format';
import { Button, Card, Icon, ease, useToast } from '../../ui';
import { STATUS_LABEL } from './model';
import './Mail.css';

const KIND_LABEL: Record<MailKind, [string, string]> = {
  interview: ['interview', 'interviews'], reply: ['reply', 'replies'], rejected: ['rejection', 'rejections'], offer: ['offer', 'offers'],
  'auto-ack': ['automatic acknowledgement', 'automatic acknowledgements'], unrelated: ['unrelated', 'unrelated'],
};

export function MailStrip({ onResult }: { onResult: (r: SyncResult) => void }) {
  const status = useQuery('mail-status', api.mailStatus);
  const [checking, setChecking] = useState(false);
  const [connecting, setConnecting] = useState<'idle' | 'starting' | 'waiting' | 'checking'>('idle');
  const toast = useToast();
  const s = status.data;

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
    try {
      const { url } = await api.mailConnect();
      window.open(url, '_blank', 'noopener');
      setConnecting('waiting');
    } catch (e) {
      setConnecting('idle');
      toast({ title: 'Could not start connecting Gmail', body: (e as Error).message, tone: 'error' });
    }
  };

  const finish = async () => {
    setConnecting('checking');
    try {
      const next = await api.mailCheck();
      await status.refetch();
      toast(next.connected ? { title: 'Gmail is connected', body: 'Check replies reads it, read-only.', tone: 'success' } : { title: 'Not connected yet', body: next.note });
    } finally {
      setConnecting('idle');
    }
  };

  const tone = !s ? 'is-loading' : s.source === 'sample' ? 'is-sample' : s.connected ? 'is-on' : 'is-off';

  return (
    <div className={['mail', tone].join(' ')} role="region" aria-label="Mail">
      <span className="t-label mail__label">Mail</span>
      <span className="mail__state">
        <span className="mail__dot" aria-hidden="true" />
        {s ? s.label : status.error ? 'Mail status unavailable' : 'Checking mail'}
      </span>
      <span className="mail__note">{s?.note ?? status.error?.message ?? ''}</span>
      <span className="mail__acts">
        {s?.canConnect && connecting !== 'waiting' && connecting !== 'checking' && (
          <Button variant="ghost" size="sm" iconLeft="plus" onClick={connect} loading={connecting === 'starting'}>
            Connect Gmail
          </Button>
        )}
        {(connecting === 'waiting' || connecting === 'checking') && (
          <Button variant="ghost" size="sm" iconLeft="check" onClick={finish} loading={connecting === 'checking'}>
            I have finished in Google
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
