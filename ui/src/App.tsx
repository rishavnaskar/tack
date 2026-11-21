import { useEffect, type ReactNode } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import { motion } from 'motion/react';
import { MOCK } from './api/client';
import { trace, useTrace } from './api/events';
import { useAppState } from './api/hooks';
import { AppShell, TraceRail, ease, type NavItem } from './ui';
import { Start } from './screens/Start';
import { Market } from './screens/Market';
import { Gap } from './screens/Gap';
import { Plan } from './screens/Plan';
import { Portfolio } from './screens/Portfolio';
import { Progress } from './screens/Progress';
import { Interview } from './screens/Interview';
import { Tracker } from './screens/Tracker';
import { Autopilot } from './screens/Autopilot';
import { Placeholder } from './screens/Placeholder';
import './App.css';

function useNav(): NavItem[] {
  const { data } = useAppState();
  const c = data?.counts;
  const show = (n?: number) => (n ? n : undefined);
  return [
    { index: '00', label: 'Start', path: '/', attention: !!data && !data.profile },
    { index: '01', label: 'Market', path: '/market', meta: show(c?.postings) },
    { index: '02', label: 'Gap map', short: 'Gap', path: '/gap' },
    { index: '03', label: 'Plan', path: '/plan' },
    { index: '04', label: 'Portfolio', short: 'Folio', path: '/portfolio' },
    { index: '05', label: 'Interview', short: 'Interview', path: '/interview', meta: show(c?.interviews) },
    { index: '06', label: 'Tracker', path: '/tracker', meta: show(c?.applications) },
    { index: '07', label: 'Progress', path: '/progress' },
    { index: '08', label: 'Autopilot', short: 'Auto', path: '/autopilot' },
  ];
}

function RailStatus() {
  const { data } = useAppState();
  // A real person is never shown sample data, so the rail never calls their app a demo.
  const real = !!data?.profile && data.profile.source !== 'demo';
  const live = !MOCK && (data?.mode === 'live' || real);
  const n = data?.counts.postings ?? 0;
  const source = !data
    ? 'Connecting'
    : MOCK
      ? 'Mock data'
      : n
        ? `${n} ${live ? 'live' : 'sample'} postings`
        : data.engine.available
          ? 'Job boards reachable'
          : real ? 'Job boards unreachable' : 'Engine off, sample data';
  return (
    <div className="rail-status" title={data?.engine.note}>
      <span className={['rail-status__dot', live && 'is-live'].filter(Boolean).join(' ')} aria-hidden="true" />
      <div className="rail-status__text">
        <span className="t-label">{live ? 'Live mode' : 'Demo mode'}</span>
        <span className="rail-status__line">{source}</span>
        {data && <span className="rail-status__line" title={data.model.name}>{data.model.configured ? data.model.name : 'No model key'}</span>}
      </div>
    </div>
  );
}

function ConnectedTraceRail() {
  const t = useTrace();
  return (
    <TraceRail
      events={t.events}
      open={t.open}
      onOpenChange={trace.setOpen}
      active={t.pending > 0 || t.hot}
      activeLabel={t.pendingLabel}
      connected={t.connected}
      unseen={t.unseen}
      onClear={trace.clear}
    />
  );
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, ease }}>
      {children}
    </motion.div>
  );
}

export function App() {
  const nav = useNav();
  const traceOpen = useTrace().open;
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);

  useEffect(() => {
    const item = nav.find((n) => (n.path === '/' ? pathname === '/' : pathname.startsWith(n.path)));
    document.title = item && item.path !== '/' ? `${item.label} · Tack` : 'Tack';
  }, [pathname, nav]);

  return (
    <AppShell nav={nav} status={<RailStatus />} overlay={<ConnectedTraceRail />} asideOpen={traceOpen}>
      <Routes>
        <Route path="/" element={<Screen key="start"><Start /></Screen>} />
        <Route path="/market" element={<Screen key="market"><Market /></Screen>} />
        <Route path="/gap" element={<Screen key="gap"><Gap /></Screen>} />
        <Route path="/plan" element={<Screen key="plan"><Plan /></Screen>} />
        <Route path="/portfolio" element={<Screen key="portfolio"><Portfolio /></Screen>} />
        <Route path="/interview" element={<Screen key="interview"><Interview /></Screen>} />
        <Route path="/tracker" element={<Screen key="tracker"><Tracker /></Screen>} />
        <Route path="/progress" element={<Screen key="progress"><Progress /></Screen>} />
        <Route path="/autopilot" element={<Screen key="autopilot"><Autopilot /></Screen>} />
        <Route path="*" element={<Screen key="404"><Placeholder screen="missing" /></Screen>} />
      </Routes>
    </AppShell>
  );
}
