import { useState } from 'react';
import { useNavigate } from 'react-router';
import { motion } from 'motion/react';
import { actions, useAppState } from '../api/hooks';
import { useHosted } from '../api/capabilities';
import { Button, Icon, Modal, ease, useToast } from '../ui';
import { Start } from './Start';
import './Landing.css';

/** The root route. On the web preview a slim strip sits above the Start screen. */
export function Landing() {
  const hosted = useHosted();
  return (
    <>
      {hosted && <TryStrip downloadUrl={hosted.downloadUrl} keptHours={hosted.retentionHours} />}
      <Start />
    </>
  );
}

function TryStrip({ downloadUrl, keptHours }: { downloadUrl: string | null; keptHours?: number }) {
  const { data: state } = useAppState();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const ownWork = !!state?.profile && state.profile.source !== 'demo';

  const load = async () => {
    setConfirm(false);
    setBusy(true);
    try {
      await actions.loadDemo();
      navigate('/gap');
    } catch (e) {
      toast({ title: 'Could not load the demo person', body: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.section
      className="try"
      aria-label="Web preview"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease }}
    >
      <div className="try__text">
        <span className="t-label">
          <span className="t-accent">Web preview</span>
        </span>
        <p>
          Try Tack with a sample person, or bring your own résumé below.
          {keptHours ? ` What you add here is deleted ${keptHours} hours after your last visit.` : ''}
        </p>
      </div>
      <div className="try__actions">
        <Button variant="primary" size="sm" icon="arrow-right" onClick={() => (ownWork ? setConfirm(true) : load())} loading={busy} disabled={!state}>
          Try with the demo person
        </Button>
        {downloadUrl && (
          <Button variant="ghost" size="sm" icon="arrow-up-right" href={downloadUrl}>
            Download the desktop app
          </Button>
        )}
      </div>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        eyebrow="Demo person"
        title="Replace your work with the demo?"
        footer={
          <>
            <Button variant="quiet" onClick={() => setConfirm(false)}>
              Keep mine
            </Button>
            <Button variant="primary" onClick={load}>
              Load Avery Quinn
            </Button>
          </>
        }
      >
        <p className="t-mute">Loading the demo person clears the profile, postings, plan and applications in this session.</p>
      </Modal>
    </motion.section>
  );
}

/** A slim notice across the top of every screen on the web preview. */
export function PreviewBanner() {
  const hosted = useHosted();
  if (!hosted) return null;
  return (
    <div className="preview-banner" role="note">
      <div className="preview-banner__inner">
        <span className="preview-banner__text">
          <strong>Web preview.</strong> Automated applying and mail reading run in the desktop app.
        </span>
        {hosted.downloadUrl && (
          <a className="preview-banner__link" href={hosted.downloadUrl}>
            Download
            <Icon name="arrow-up-right" size={13} />
          </a>
        )}
      </div>
    </div>
  );
}
