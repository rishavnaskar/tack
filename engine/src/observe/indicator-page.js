/*
 * Fanfold's "working here" indicator, as it runs in the page.
 *
 * Evaluated in an isolated world of Fanfold's own, so the page's scripts can
 * neither call it nor replace what it calls. One host element on
 * documentElement (never inside body, so the serializer never walks it), a
 * closed shadow root, aria-hidden, and pointer-events: none on everything, so
 * it is never read, never hit-tested and never clicked. It removes itself when
 * Fanfold stops beating: a crash or a detach cannot leave it lying.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function fanfoldIndicator(config) {
  'use strict';
  if (window.top !== window) return 'frame';
  const api = globalThis.__fanfoldIndicator;
  if (api) return api.beat(config.state);

  const TAG = 'fanfold-indicator';
  const EXPIRE_MS = config.expireMs;
  const RESTORES_PER_MINUTE = 5;
  const FADE_MS = 600;
  const PAGE = 'M-7.5,-82.0 H7.5 A6.5,6.5 0 0 1 14.0,-75.5 V-28.5 A6.5,6.5 0 0 1 7.5,-22.0 H-7.5 A6.5,6.5 0 0 1 -14.0,-28.5 V-75.5 A6.5,6.5 0 0 1 -7.5,-82.0 Z';
  const FRONT = 'M-7.5,-82.0 H3.0 L14.0,-71.0 V-28.5 A6.5,6.5 0 0 1 7.5,-22.0 H-7.5 A6.5,6.5 0 0 1 -14.0,-28.5 V-75.5 A6.5,6.5 0 0 1 -7.5,-82.0 Z';
  const CSS = `
    .root { --edge: #f0521c; --glow: rgba(240, 82, 28, 0.32); --pill: #0b0b0c; --ink: #f7f6f4; --page: #f7f6f4; --line: #0b0b0c; --front: #ff7a3d;
      position: fixed; inset: 0; pointer-events: none; }
    @media (prefers-color-scheme: dark) {
      .root { --edge: #ff7a3d; --glow: rgba(255, 122, 61, 0.32); --pill: #f7f6f4; --ink: #0b0b0c; --page: #0b0b0c; --line: #f7f6f4; --front: #f0521c; }
    }
    .edge { position: fixed; inset: 0; pointer-events: none;
      box-shadow: inset 0 0 0 2px var(--edge), inset 0 0 22px 3px var(--glow); }
    .waiting .edge { opacity: 0.8; }
    .paused .edge { opacity: 0.55; box-shadow: inset 0 0 0 2px var(--edge); }
    .pill { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); pointer-events: none;
      display: flex; align-items: center; gap: 7px; height: 28px; box-sizing: border-box; padding: 0 12px 0 7px;
      border-radius: 14px; background: var(--pill); color: var(--ink); white-space: nowrap; user-select: none;
      box-shadow: 0 0 0 1.5px var(--edge), 0 4px 14px rgba(11, 11, 12, 0.22);
      font: 500 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; letter-spacing: 0; }
    .mark { width: 18px; height: 18px; flex: none; display: block; }
    .mark .sheet { fill: var(--page); stroke: var(--line); stroke-width: 4.5; stroke-linejoin: round; }
    .mark .front { fill: var(--front); stroke: var(--line); stroke-width: 4.5; stroke-linejoin: round; }
  `;

  let state = config.state;
  let lastBeat = Date.now();
  let shown = true;
  const restores = [];
  let host = null;
  let root = null;
  let label = null;

  function important(el, styles) {
    for (const [k, v] of Object.entries(styles)) el.style.setProperty(k, v, 'important');
  }

  function build() {
    host = document.createElement(TAG);
    host.setAttribute('aria-hidden', 'true');
    important(host, {
      position: 'fixed', inset: '0', 'z-index': '2147483647', 'pointer-events': 'none', display: 'block',
      margin: '0', padding: '0', border: '0', background: 'transparent', width: 'auto', height: 'auto',
      opacity: '1', visibility: 'visible', transform: 'none', filter: 'none', contain: 'strict',
    });
    const shadow = host.attachShadow({ mode: 'closed' });
    let styled = false;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
      styled = true;
    } catch {
      // Without constructable sheets the indicator is drawn plainly, still inert.
    }
    root = document.createElement('div');
    const edge = document.createElement('div');
    edge.className = 'edge';
    const pill = document.createElement('div');
    pill.className = 'pill';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('class', 'mark');
    for (const [angle, d, cls] of [[-21, PAGE, 'sheet'], [-7, PAGE, 'sheet'], [7, PAGE, 'sheet'], [21, FRONT, 'front']]) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', cls);
      path.setAttribute('transform', `translate(50,99.308) rotate(${angle})`);
      svg.appendChild(path);
    }
    label = document.createElement('span');
    pill.append(svg, label);
    root.append(edge, pill);
    shadow.appendChild(root);
    if (!styled) {
      important(root, { position: 'fixed', inset: '0', 'pointer-events': 'none' });
      important(edge, { position: 'fixed', inset: '0', 'pointer-events': 'none', 'box-shadow': 'inset 0 0 0 2px #f0521c' });
      important(pill, {
        position: 'fixed', top: '10px', left: '50%', transform: 'translateX(-50%)', 'pointer-events': 'none',
        display: 'flex', 'align-items': 'center', gap: '7px', padding: '6px 12px 6px 7px', 'border-radius': '14px',
        background: '#0b0b0c', color: '#f7f6f4', font: '500 12.5px/1 system-ui, sans-serif', 'white-space': 'nowrap',
      });
      important(svg, { width: '18px', height: '18px' });
      for (const path of svg.childNodes) path.setAttribute('fill', path.getAttribute('class') === 'front' ? '#ff7a3d' : '#f7f6f4');
    }
    paint();
  }

  function paint() {
    root.className = `root ${state}`;
    label.textContent = config.texts[state] || config.texts.working;
  }

  // A kept tab can wait for hours: it is drawn once and then left still, so
  // Chrome has nothing to repaint. One short fade marks a new state.
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function fade() {
    if (still || !root || typeof root.animate !== 'function') return;
    try {
      root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-out', iterations: 1 });
    } catch {
      // Drawn without the fade.
    }
  }

  function attach() {
    if (!shown || !document.documentElement) return false;
    const fresh = !host;
    if (fresh) build();
    if (host.parentNode !== document.documentElement) document.documentElement.appendChild(host);
    if (fresh) fade();
    return true;
  }

  function restore() {
    if (!shown || !host || host.isConnected || !document.documentElement) return;
    const now = Date.now();
    while (restores.length && now - restores[0] > 60_000) restores.shift();
    // A page that keeps removing it is let win after a few tries, until the next minute.
    if (restores.length >= RESTORES_PER_MINUTE) return;
    restores.push(now);
    attach();
  }

  function remove() {
    shown = false;
    if (host && host.parentNode) host.parentNode.removeChild(host);
  }

  const observer = new MutationObserver(() => {
    if (host) return restore();
    // A new document gets its root element after this script ran: draw as soon as it has one.
    if (attach()) watch();
  });
  function watch() {
    observer.disconnect();
    observer.observe(document, { childList: true });
    if (document.documentElement) observer.observe(document.documentElement, { childList: true });
  }

  // One timer, moved on by each beat: nothing wakes the page between beats.
  let timer = null;
  function expireLater() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (shown && Date.now() - lastBeat >= EXPIRE_MS) remove();
      else if (shown) expireLater();
    }, Math.max(0, lastBeat + EXPIRE_MS - Date.now()));
  }
  expireLater();

  globalThis.__fanfoldIndicator = {
    beat(next) {
      lastBeat = Date.now();
      expireLater();
      if (next && next !== state) {
        state = next;
        if (host) {
          paint();
          fade();
        }
      }
      if (!shown) {
        shown = true;
        restores.length = 0;
      }
      if (!host) attach();
      else restore();
      watch();
      return 'beat';
    },
    hide(hidden) {
      if (!host) return Promise.resolve(false);
      host.style.setProperty('display', hidden ? 'none' : 'block', 'important');
      // One frame drawn without it before the capture is taken.
      return new Promise((resolve) => {
        const done = () => resolve(true);
        requestAnimationFrame(() => requestAnimationFrame(done));
        setTimeout(done, 120);
      });
    },
    clear() {
      remove();
      observer.disconnect();
      clearTimeout(timer);
      delete globalThis.__fanfoldIndicator;
      return 'cleared';
    },
  };

  attach();
  watch();
  return 'drawn';
}
