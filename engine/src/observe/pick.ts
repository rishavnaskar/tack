/**
 * Choosing an option in a list the page draws itself: a searchable dropdown,
 * a combobox made of divs, a field that suggests as you type.
 *
 * Which option an answer means is decided here, out of the page, so it can
 * be held to the same care as a native dropdown: the exact text first, then
 * the same words whatever their case, spacing or punctuation, then the one
 * option that begins with the answer or holds it as whole words. Nothing
 * looser, and nothing when two options fit equally: "No" must never land on
 * "Not sure", and "Bengaluru" must not choose between two Bengalurus.
 */

type Choice ={ index: number } | { ambiguous: string[] } | null;

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
/** Words only: case, spacing and punctuation (straight or curly quotes, commas, brackets) set aside. */
const loose = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function chooseOption(want: string, options: readonly string[]): Choice {
  const tiers: Array<(o: string) => boolean> = [
    (o) => o.trim() === want.trim(),
    (o) => squash(o) === squash(want),
    (o) => !!loose(want) && loose(o) === loose(want),
    (o) => !!loose(want) && loose(o).startsWith(`${loose(want)} `),
    (o) => !!loose(want) && ` ${loose(o)} `.includes(` ${loose(want)} `),
  ];
  for (const [tier, fits] of tiers.entries()) {
    const found = options.map((o, i) => (fits(o) ? i : -1)).filter((i) => i >= 0);
    // The same text twice is one choice; two different options that both fit loosely are not.
    if (found.length === 1 || (found.length > 1 && tier < 2)) return { index: found[0] };
    if (found.length > 1) return { ambiguous: found.map((i) => options[i]) };
  }
  return null;
}

/**
 * Page side. `window.__ba.pick` holds the options last read, so the one
 * chosen is clicked as it was read; the options shown before the list was
 * opened tell a list that opened from one that was already on the page.
 */
const SHOWN = `const shown = (o) => o.isConnected && o.getClientRects().length > 0
      && (typeof o.checkVisibility !== 'function' || o.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));`;

/** Options by their role, or by the ids a select widget gives options it draws without one (react-select's "…-option-3"). */
const ALL_OPTIONS = `const all = (doc) => [...new Set([...doc.querySelectorAll('[role=option], [id*="-option-"]')])].filter((o) => !o.closest('select, datalist'));`;

/** What the control is, before anything is done to it. */
export function pickerState(ref: string): string {
  return `(() => {
    const el = window.__ba && window.__ba.refs.get(${JSON.stringify(ref)});
    if (!el) return null;
    ${SHOWN}
    ${ALL_OPTIONS}
    window.__ba.pickBefore = new Set(all(el.ownerDocument).filter(shown));
    const typed = (el.tagName === 'INPUT' && !/^(submit|image|reset|button|checkbox|radio|file)$/i.test(el.type)) || el.tagName === 'TEXTAREA' || el.isContentEditable;
    const popup = (el.getAttribute('aria-haspopup') || '').toLowerCase();
    const button = el.closest('button, input[type=submit], input[type=image], a[href]');
    // What the field shows as chosen now: its own words or value, or the box it sits in with any open list left out.
    const squash = (t) => (t || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const bare = (n) => { const c = n.cloneNode(true); for (const x of c.querySelectorAll('[role=listbox], [role=option], [id*="-option-"], [id$="-listbox"], input')) x.remove(); return squash(c.textContent); };
    const showing = [typeof el.value === 'string' && el.value ? squash(el.value) : bare(el), el.parentElement ? bare(el.parentElement) : ''];
    // A field whose suggestions the browser draws from a <datalist>: nothing on the page to click.
    const aria = el.hasAttribute('aria-controls') || el.hasAttribute('aria-owns') || el.hasAttribute('aria-autocomplete');
    const datalist = el.list && !aria ? [...el.list.options].map((o) => o.value || o.textContent || '').filter(Boolean).slice(0, 300) : null;
    // A list box that shows its options inside itself, open all the time: nothing opens it.
    const inline = (el.getAttribute('role') || '').toLowerCase() === 'listbox' && [...el.querySelectorAll('[role=option]')].some(shown);
    return {
      typed,
      datalist,
      showing,
      inline,
      presses: !!button && !(button.tagName === 'BUTTON' && ((button.getAttribute('type') || '').toLowerCase() === 'button' || !button.form)),
      value: typeof el.value === 'string' ? el.value : '',
      expanded: el.getAttribute('aria-expanded') === 'true',
      list: ['combobox', 'listbox'].includes((el.getAttribute('role') || '').toLowerCase())
        || el.hasAttribute('aria-autocomplete') || popup === 'listbox' || popup === 'true' || !!el.getAttribute('list'),
    };
  })()`;
}

/** The control's own search box, when opening it put the focus in one. */
export function focusedSearch(ref: string): string {
  return `(() => {
    const el = window.__ba && window.__ba.refs.get(${JSON.stringify(ref)});
    if (!el) return false;
    let a = el.ownerDocument.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return !!a && a !== el && a.tagName === 'INPUT' && /^(text|search|)$/i.test(a.getAttribute('type') || '');
  })()`;
}

/** The options the list shows now, by their words. */
export function listedOptions(ref: string): string {
  return `(() => {
    const el = window.__ba && window.__ba.refs.get(${JSON.stringify(ref)});
    if (!el) return [];
    const doc = el.ownerDocument;
    ${SHOWN}
    ${ALL_OPTIONS}
    const owners = [el, doc.activeElement].filter(Boolean);
    const ids = new Set(owners.flatMap((x) => ((x.getAttribute('aria-controls') || '') + ' ' + (x.getAttribute('aria-owns') || '')).split(/\\s+/)).filter(Boolean));
    const lists = [...ids].map((id) => doc.getElementById(id)).filter(Boolean);
    // A list box is its own list: its options are inside it.
    if ((el.getAttribute('role') || '').toLowerCase() === 'listbox') lists.push(el);
    let options = [...new Set(lists.flatMap((l) => (l.matches('[role=option]') ? [l] : [...l.querySelectorAll('[role=option]')])))].filter(shown);
    if (!options.length) {
      const before = window.__ba.pickBefore || new Set();
      const visible = all(doc).filter(shown);
      options = visible.filter((o) => !before.has(o));
      if (!options.length && el.getAttribute('aria-expanded') === 'true') options = visible;
    }
    options = options.filter((o) => o.getAttribute('aria-disabled') !== 'true');
    window.__ba.pick = options;
    return options.map((o) => (o.innerText || o.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 300);
  })()`;
}

/** Where to click the option read at `index`, in the page's top-level coordinates; null when it is gone or covered. */
export function optionPoint(index: number): string {
  return `(() => {
    const o = window.__ba && window.__ba.pick && window.__ba.pick[${index}];
    if (!o || !o.isConnected) return null;
    o.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const r = o.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    let x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = o.ownerDocument.elementFromPoint(x, y);
    if (!hit || !(hit === o || o.contains(hit))) return null;
    for (let w = o.ownerDocument.defaultView; w && w !== window && w.frameElement; w = w.parent) {
      const f = w.frameElement.getBoundingClientRect();
      const cs = w.frameElement.ownerDocument.defaultView.getComputedStyle(w.frameElement);
      x += f.x + parseFloat(cs.borderLeftWidth || '0') + parseFloat(cs.paddingLeft || '0');
      y += f.y + parseFloat(cs.borderTopWidth || '0') + parseFloat(cs.paddingTop || '0');
    }
    return { x, y };
  })()`;
}

/** Whether the list box marks this option as the one chosen: selected, checked or active. */
export function optionChosen(ref: string, index: number): string {
  return `(() => {
    const el = window.__ba && window.__ba.refs.get(${JSON.stringify(ref)});
    const o = window.__ba && window.__ba.pick && window.__ba.pick[${index}];
    if (!el || !o) return false;
    if (o.getAttribute('aria-selected') === 'true' || o.getAttribute('aria-checked') === 'true') return true;
    const active = el.getAttribute('aria-activedescendant');
    return !!active && active === o.id;
  })()`;
}

/**
 * How many times the field and the few elements around it say these words,
 * with any open list left out: the count rises when the field shows the
 * option chosen, wherever the widget draws it.
 */
export function shownCount(ref: string, words: string): string {
  return `(() => {
    const el = window.__ba && window.__ba.refs.get(${JSON.stringify(ref)});
    if (!el) return null;
    const want = ${JSON.stringify(words.replace(/\s+/g, ' ').trim().toLowerCase())};
    if (!want) return null;
    const squash = (s) => s.replace(/\\s+/g, ' ').trim().toLowerCase();
    const count = (s) => { let n = 0; for (let i = s.indexOf(want); i >= 0; i = s.indexOf(want, i + want.length)) n++; return n; };
    const counts = [];
    for (let n = el, i = 0; n && i < 4; n = n.parentElement, i++) {
      const copy = n.cloneNode(true);
      for (const x of copy.querySelectorAll('[role=listbox], [role=option], [id*="-option-"], [id$="-listbox"]')) x.remove();
      counts.push(count(squash(copy.textContent || '')));
    }
    return { value: typeof el.value === 'string' ? squash(el.value) : null, counts };
  })()`;
}
