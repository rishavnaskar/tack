import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router';
import { MotionConfig } from 'motion/react';
import '@fontsource-variable/host-grotesk';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './ui/tokens.css';
import './ui/base.css';
import { ToastProvider } from './ui';
import { App } from './App';

// file:// (packaged shell without a server) cannot use history routing.
const Router = location.protocol === 'file:' ? HashRouter : BrowserRouter;

// The desktop app hides the macOS title bar; the shell then leaves room for the traffic lights.
const desktop = (window as { tackDesktop?: { titleBar?: string } }).tackDesktop;
if (desktop?.titleBar === 'hiddenInset') document.documentElement.dataset.titlebar = 'inset';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <Router>
        <ToastProvider>
          <App />
        </ToastProvider>
      </Router>
    </MotionConfig>
  </StrictMode>,
);
