/**
 * In-page observation serializer.
 *
 * Injected once per document via Page.addScriptToEvaluateOnNewDocument. Plain
 * JavaScript on purpose — it runs in the page, not in Node, so it must not go
 * through any build or type-stripping step.
 *
 * Design notes that matter:
 *
 *  - ONE pass. We walk the DOM a single time and compute role, accessible
 *    name, value, state and visibility per node. Accessibility.getFullAXTree
 *    is chattier and carries a large number of ignored nodes.
 *
 *  - We compute the accessible name OURSELVES rather than trusting authored
 *    ARIA. Task success on browser agents drops sharply on sites with a
 *    degraded accessibility tree, so `aria-label` is the first choice we try,
 *    never the only one: we fall back through label association, alt, title,
 *    placeholder, value, and finally visible text.
 *
 *  - Refs are LEASES. Every observation mints a new stateId and a fresh ref
 *    map. Acting with a ref from a previous observation must fail rather than
 *    silently re-resolve, because a re-render that shifts element order is
 *    exactly how an agent clicks the wrong button.
 *
 *  - We record (role, name) per ref so the act path can detect drift: the
 *    element is still attached, but it is no longer the thing we observed.
 */
(() => {
  const VERSION = 23;
  if (window.__ba && window.__ba.version === VERSION) return;

  /** Fanfold's indicator (indicator.ts), skipped by name wherever it is found. */
  const INDICATOR_TAG = 'FANFOLD-INDICATOR';
  const MAX_NODES = 1500;
  const MAX_TEXT = 200;
  /** Field labels and questions: an application's questions run longer than ordinary text. */
  const MAX_LABEL = 500;
  /** A question in plain text beside its answers, or a long paragraph while the budget for them lasts. */
  const MAX_LONG = 1000;
  /** Characters past MAX_TEXT that one snapshot gives questions, and description paragraphs. */
  const ASK_BUDGET = 12000;
  const PARAGRAPH_BUDGET = 3000;
  /** Text nodes of no recognised role that one snapshot carries. */
  const GENERIC_TEXT_BUDGET = 120;
  const CONTROLS = 'input:not([type=hidden]), select, textarea, button, [role=radio], [role=checkbox], [role=switch], ' +
    '[role=combobox], [role=textbox], [role=button], [role=radiogroup], [role=listbox], [role=spinbutton]';
  const MAX_OPTIONS = 300;
  /** What a dropdown shows before anything is chosen: "Select...", "Please select", "-- Choose one --". */
  const PROMPT = /^[-\s]*(please )?(select|choose|pick)( one| an option| an answer)?[\s.…:-]*$/i;
  /** Options of one open list shown before the rest are only counted. */
  const MAX_LIST_OPTIONS = 40;

  // ---------------------------------------------------------------- roles

  const INTERACTIVE = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
    'listbox', 'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'treeitem',
  ]);

  const CONTENT = new Set([
    'heading', 'cell', 'columnheader', 'rowheader', 'listitem', 'article',
    'region', 'main', 'navigation', 'banner', 'contentinfo', 'complementary',
    'dialog', 'alertdialog', 'alert', 'status', 'img', 'paragraph', 'form', 'search',
  ]);

  // Implicit ARIA role of each <input type>, grouped by role.
  const INPUT_TYPES_BY_ROLE = {
    button: ['button', 'submit', 'reset', 'image', 'file'],
    checkbox: ['checkbox'],
    radio: ['radio'],
    slider: ['range'],
    spinbutton: ['number'],
    searchbox: ['search'],
    textbox: ['text', 'email', 'tel', 'url', 'password', 'date', 'datetime-local', 'month', 'week', 'time'],
  };
  const INPUT_ROLE = {};
  for (const [role, types] of Object.entries(INPUT_TYPES_BY_ROLE)) {
    for (const type of types) INPUT_ROLE[type] = role;
  }

  const TAG_ROLE = {
    A: null, // depends on href
    BUTTON: 'button', SUMMARY: 'button', TEXTAREA: 'textbox', SELECT: null,
    OPTION: 'option', H1: 'heading', H2: 'heading', H3: 'heading',
    H4: 'heading', H5: 'heading', H6: 'heading', UL: 'list', OL: 'list',
    LI: 'listitem', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader',
    NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo',
    ASIDE: 'complementary', FORM: 'form', DIALOG: 'dialog', IMG: 'img',
    P: 'paragraph', ARTICLE: 'article', SECTION: 'region', FIGURE: 'figure',
    HR: 'separator', PROGRESS: 'progressbar', OUTPUT: 'status',
  };

  function explicitRole(el) {
    const r = el.getAttribute && el.getAttribute('role');
    if (!r) return null;
    const first = r.trim().split(/\s+/)[0];
    return first ? first.toLowerCase() : null;
  }

  function implicitRole(el) {
    const tag = el.tagName;
    if (tag === 'A' || tag === 'AREA') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return INPUT_ROLE[t] || 'textbox';
    }
    if (tag === 'SELECT') {
      return el.multiple || (el.size && el.size > 1) ? 'listbox' : 'combobox';
    }
    if (tag === 'TH') {
      const scope = (el.getAttribute('scope') || '').toLowerCase();
      return scope === 'row' ? 'rowheader' : 'columnheader';
    }
    if (tag === 'IMG') {
      // alt="" is an explicit author signal that the image is decorative.
      return el.getAttribute('alt') === '' ? null : 'img';
    }
    if (Object.prototype.hasOwnProperty.call(TAG_ROLE, tag)) return TAG_ROLE[tag];
    if (el.isContentEditable) return 'textbox';
    // A div/span the author made focusable and clickable is a control in
    // practice even without a role attribute. Common on modern SPA sites.
    if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') {
      if (el.hasAttribute('onclick') || el.hasAttribute('aria-label')) return 'button';
    }
    return null;
  }

  function roleOf(el) {
    return explicitRole(el) || implicitRole(el);
  }

  // ------------------------------------------------------- accessible name

  // A cut is marked, so a screening question that runs on is not read as whole.
  function clean(s, max) {
    if (!s) return '';
    const limit = max || MAX_TEXT;
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > limit ? t.slice(0, limit - 1) + '…' : t;
  }

  function textFrom(el, depth) {
    // Deep enough for a result card, whose title sits many wrappers down.
    if (!el || depth > 20) return '';
    let out = '';
    // A slot's words are whatever was put into it, which are not its children.
    const slotted = el.tagName === 'SLOT' && el.assignedNodes ? el.assignedNodes({ flatten: true }) : [];
    for (const node of slotted.length ? slotted : el.childNodes) {
      if (node.nodeType === 3) {
        out += node.nodeValue;
      } else if (node.nodeType === 1) {
        if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === INDICATOR_TAG) continue;
        if (isHidden(node)) continue;
        const alt = node.getAttribute && node.getAttribute('alt');
        if (node.tagName === 'IMG' && alt) out += ' ' + alt + ' ';
        else out += ' ' + textFrom(node, depth + 1) + ' ';
      }
      if (out.length > MAX_TEXT * 3) break;
    }
    return out;
  }

  function labelText(el) {
    // <label for=id>, or an ancestor <label>
    if (el.id) {
      try {
        const root = el.getRootNode();
        const forLabel = root.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (forLabel) return clean(textFrom(forLabel, 0), MAX_LABEL);
      } catch { /* invalid id for selector */ }
    }
    const ancestor = el.closest && el.closest('label');
    if (ancestor) return clean(textFrom(ancestor, 0), MAX_LABEL);
    return '';
  }

  /** The words of the elements an attribute such as aria-labelledby names. */
  function refText(el, attr) {
    let out = '';
    for (const target of refTargets(el, attr)) out += ' ' + textFrom(target, 0);
    return clean(out, MAX_LABEL);
  }

  // Roles whose name comes from their own content.
  const NAMED_BY_CONTENT = new Set([
    'button', 'link', 'heading', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
    'treeitem', 'cell', 'columnheader', 'rowheader', 'listitem', 'switch', 'checkbox', 'radio',
  ]);

  /**
   * Was this name read from the element's own text, in full? Only then does
   * it stand in for the leaves under it: a label an author wrote
   * ("Jobs in London") says nothing about what the cards inside hold.
   */
  function namedByItsText(el, role, name) {
    return NAMED_BY_CONTENT.has(role) && name.length < MAX_TEXT &&
      !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby');
  }

  /**
   * A radio or checkbox's own words ("Yes"), when the name it carries is its
   * question: its own label, or the text in a box that holds it and nothing
   * else to answer, or else the value it sends. Never a neighbour's words:
   * the text after a radio can be the next radio's answer.
   */
  function optionText(el) {
    if (el.tagName !== 'INPUT' || (el.type !== 'radio' && el.type !== 'checkbox')) return '';
    const own = labelText(el);
    if (own) return own;
    const box = el.parentElement;
    if (box && box.querySelectorAll('input, select, textarea, button').length === 1) {
      const t = clean(textFrom(box, 0));
      if (t && t.length <= 60) return t;
    }
    const sent = (el.getAttribute('value') || '').trim();
    return /^[A-Za-z][\w '’().,/-]{0,39}$/.test(sent) && sent.toLowerCase() !== 'on' ? sent : '';
  }

  function accessibleName(el, role) {
    const name = ownName(el, role);
    // A file input is often named only "Attach": the question is its group's.
    if (isFileInput(el)) {
      const q = questionOf(el, 'file');
      if (q && name.indexOf(q.text) < 0) return clean(q.text + (name ? ' ' + name : ''), MAX_LABEL);
    }
    return name;
  }

  /**
   * A pragmatic subset of the accname algorithm, ordered by the spec's
   * precedence. Not spec-complete (no full traversal of aria-owns, no
   * CSS ::before/::after content), but it covers what real pages use and,
   * crucially, it degrades to visible text instead of returning nothing.
   */
  function ownName(el, role) {
    const byLabelledBy = refText(el, 'aria-labelledby');
    const ariaLabel = clean(el.getAttribute('aria-label'), MAX_LABEL);
    const option = (byLabelledBy || ariaLabel) ? optionText(el) : '';
    if (option && option !== byLabelledBy && option !== ariaLabel) return option;
    if (byLabelledBy) return byLabelledBy;
    if (ariaLabel) return ariaLabel;

    const tag = el.tagName;

    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const lbl = labelText(el);
      if (lbl) return lbl;
      const ph = clean(el.getAttribute('placeholder'));
      // A typeahead's placeholder ("Start typing...") says how to use it, not what it asks.
      if (ph && (role === 'combobox' || el.hasAttribute('aria-autocomplete'))) {
        const asked = askedAbove(el);
        if (asked) return asked;
      }
      if (ph) return ph;
      const option = optionText(el);
      if (option) return option;
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'INPUT' && (t === 'button' || t === 'submit' || t === 'reset')) {
        const v = clean(el.value);
        if (v) return v;
        if (t === 'submit') return 'Submit';
        if (t === 'reset') return 'Reset';
      }
      if (tag === 'INPUT' && t === 'image') {
        const alt = clean(el.getAttribute('alt'));
        if (alt) return alt;
      }
      const nm = clean(el.getAttribute('name'));
      if (nm) return nm;
    }

    if (tag === 'IMG' || tag === 'AREA') {
      const alt = clean(el.getAttribute('alt'));
      if (alt) return alt;
    }

    if (tag === 'FIGURE') {
      const cap = el.querySelector('figcaption');
      if (cap) return clean(textFrom(cap, 0));
    }
    if (tag === 'TABLE') {
      const cap = el.querySelector('caption');
      if (cap) return clean(textFrom(cap, 0));
    }
    if (tag === 'FIELDSET') {
      const lg = el.querySelector('legend');
      if (lg) return clean(textFrom(lg, 0));
    }

    if (NAMED_BY_CONTENT.has(role)) {
      const t = clean(textFrom(el, 0));
      if (t) return t;
    }

    const title = clean(el.getAttribute('title'));
    if (title) return title;

    // Last resort for SVG-only icon buttons, which otherwise read as unnamed.
    const svgTitle = el.querySelector && el.querySelector('svg title');
    if (svgTitle) return clean(svgTitle.textContent);

    return '';
  }

  /** The words above a field that has no label of its own: a label or heading in its own box, or the block before that box. */
  function askedAbove(el) {
    let box = el.parentElement;
    for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
      if (box.querySelectorAll('input:not([type=hidden]), select, textarea').length > 1) return '';
      for (const l of box.querySelectorAll('label, legend, [class*="label" i], [class*="question" i], [class*="title" i]')) {
        if (l.contains(el) || isHidden(l)) continue;
        const t = clean(textFrom(l, 0), MAX_LABEL);
        if (t) return t;
      }
      const prev = box.previousElementSibling;
      if (prev && !prev.matches(CONTROLS) && !prev.querySelector(CONTROLS) && !isHidden(prev)) {
        const t = clean(textFrom(prev, 0), MAX_LABEL);
        if (t) return t;
      }
    }
    return '';
  }

  /**
   * The question a set of options answers. Stated by a fieldset's legend or a
   * labelled group; otherwise, on forms built from divs, the text just above
   * the list of options (Lever: a label div, then a list of checkboxes).
   */
  function questionOf(el, control) {
    const required = (t, group) => /[*✱]\s*$/.test(t) || (group && group.getAttribute('aria-required') === 'true');
    const strip = (t) => t.replace(/\s*[*✱]\s*$/, '');
    const group = el.closest('fieldset, [role=radiogroup], [role=group]');
    if (group) {
      const legend = group.tagName === 'FIELDSET' ? group.querySelector(':scope > legend') : null;
      const t = legend ? clean(textFrom(legend, 0), MAX_LABEL) : accessibleName(group, 'group');
      if (t) return { text: strip(t), required: required(t, group) };
    }
    if (control === 'file') return null;
    // Yes/No buttons that stay pressed answer a question the way radios do (Ashby).
    const toggle = el.tagName !== 'INPUT' && el.hasAttribute('aria-pressed');
    let box = el.parentElement;
    for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
      const peers = box.querySelectorAll(toggle ? '[aria-pressed]' : 'input[type="' + el.type + '"]');
      if (peers.length < 2) continue;
      if (toggle && peers.length > 6) return null;
      // A box holding other fields too is the form, not this question's list.
      if (box.querySelectorAll('input:not([type=hidden]), select, textarea, button').length > peers.length) return null;
      // A box holding radios of other groups is past this group's own box.
      if (el.type === 'radio' && el.name && [...peers].some((r) => r.name !== el.name)) return null;
      const prev = box.previousElementSibling;
      if (!prev || prev.matches(CONTROLS) || prev.querySelector('input, select, textarea, button')) return null;
      const t = clean(textFrom(prev, 0), MAX_LABEL);
      const marked = prev.matches('[class*="required" i]') || !!prev.querySelector('[class*="required" i]');
      return t ? { text: strip(t), required: required(t, null) || marked } : null;
    }
    return null;
  }

  // ----------------------------------------------------------- evidence

  /** The element keys would reach: through same-origin frames and open shadow roots. */
  function deepActive() {
    let a = document.activeElement;
    for (let guard = 0; a && guard < 20; guard++) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') {
        let doc = null;
        try { doc = a.contentDocument; } catch { doc = null; }
        const inner = doc && doc.activeElement;
        if (inner && inner !== doc.body && inner !== doc.documentElement) { a = inner; continue; }
      }
      break;
    }
    return a;
  }

  // Forms are told apart per document and per shadow root: each has its own list.
  const rootKeys = new WeakMap();
  let rootsSeen = 0;
  function formIndexOf(form) {
    const root = form.getRootNode();
    let key = root === document ? 0 : rootKeys.get(root);
    if (key === undefined) { key = ++rootsSeen; rootKeys.set(root, key); }
    const forms = root.nodeType === 9 ? root.forms : root.querySelectorAll('form');
    return key * 1000 + Array.prototype.indexOf.call(forms, form);
  }

  /**
   * Structural facts about what a control actually DOES.
   *
   * The policy engine cannot classify an action safely from an accessible
   * name: a button reading "Submit" might run a search or send a message, and
   * an unnamed icon button gives nothing at all. These are the properties
   * that distinguish a query from a write — form method and action, link
   * destination, submit-ness, input type, and whether the element sits in a
   * message composer. Collected here because only the page can know them.
   */
  function evidenceFor(el) {
    const ev = {};
    const tag = el.tagName;

    if (tag === 'A' || tag === 'AREA') {
      const href = el.getAttribute('href') || '';
      ev.href = href.slice(0, 300);
      try {
        const url = new URL(el.href, location.href);
        ev.scheme = url.protocol.replace(':', '');
        ev.destOrigin = url.origin;
        ev.sameOrigin = url.origin === location.origin;
      } catch { /* javascript: and mailto: land here */ }
      // A link that scripts intercept is not necessarily a navigation.
      if (href.startsWith('javascript:') || href === '#' || href === '') ev.scripted = true;
    }

    if (tag === 'BUTTON' || tag === 'INPUT') {
      const type = (el.getAttribute('type') || (tag === 'BUTTON' ? 'submit' : 'text')).toLowerCase();
      ev.inputType = type;
      ev.isSubmit = type === 'submit' || type === 'image';
    }

    // Form association, including inputs linked by the form= attribute.
    const form = el.form || (el.closest ? el.closest('form') : null);
    if (form) {
      ev.inForm = true;
      // Which form, not just where it posts: a header search box and an
      // application form can both be GET forms to the same site.
      ev.formIndex = formIndexOf(form);
      ev.formMethod = (form.getAttribute('method') || 'get').toLowerCase();
      try {
        const action = new URL(form.getAttribute('action') || location.href, location.href);
        ev.formActionOrigin = action.origin;
        ev.formSameOrigin = action.origin === location.origin;
      } catch { /* leave unset */ }
      if (form.getAttribute('role') === 'search' || form.getAttribute('aria-label')) {
        ev.formLabel = clean(form.getAttribute('aria-label') || '').slice(0, 60);
      }
    }

    // What Enter or Space would reach, inside frames and shadow roots too.
    if (el === deepActive()) ev.focused = true;

    // Is this inside something that looks like a message composer? Used to
    // decide what Enter means, and only trusted alongside actual focus.
    const composer = el.closest && el.closest(
      '[role="textbox"],[contenteditable="true"],textarea,form[role="search"]',
    );
    if (composer && composer !== el) ev.inEditable = composer.tagName !== 'FORM';
    if (el.isContentEditable || tag === 'TEXTAREA') ev.editable = true;
    const control = controlOf(el);
    if (control !== 'other') ev.control = control;
    // A radio's or checkbox's label is only its answer ("No"), and a file
    // input's is often only "Attach": the question is the group's.
    const toggle = el.hasAttribute('aria-pressed');
    if (control === 'radio' || control === 'checkbox' || control === 'file' || toggle) {
      // Named by its question and labelled by its answer: the question it
      // names is the group's, before anything is guessed from the layout.
      const asked = control === 'radio' || control === 'checkbox'
        ? refText(el, 'aria-labelledby') || clean(el.getAttribute('aria-label'), MAX_LABEL) : '';
      const own = asked ? optionText(el) : '';
      const q = asked && own && asked !== own
        ? { text: asked.replace(/\s*[*✱]\s*$/, ''), required: /[*✱]\s*$/.test(asked) || el.required }
        : questionOf(el, control);
      if (q) { ev.group = q.text; if (q.required) ev.groupRequired = true; }
    }

    // aria-expanded means a disclosure: opening a section is not a write.
    if (el.hasAttribute('aria-expanded')) ev.disclosure = true;
    if (el.hasAttribute('aria-haspopup')) ev.opensMenu = true;

    return ev;
  }

  /**
   * Bounded capture of text that belongs to no recognised role.
   *
   * Ordinary div/span layouts carry most of the meaning on many sites — job
   * descriptions, SPA result rows — and a serializer that only emits known
   * roles goes blind to them. Captured as leaf text only, with a budget, so
   * this cannot turn the snapshot back into raw HTML.
   */
  function leafText(el, max) {
    if (el.children.length > 0) return '';
    const t = ownText(el, max);
    // One character is noise, except an answer: "5" years, "Y", in a review list or a table cell.
    if (t.length < 2 && !(t && /^(DD|TD|SPAN|P|DIV)$/.test(el.tagName) && /[0-9A-Za-z]/.test(t))) return '';
    return t;
  }

  /** A label whose words are already the name of the control it labels. */
  function namesItsControl(el, text) {
    if (el.tagName !== 'LABEL' || !el.control) return false;
    const role = roleOf(el.control);
    return !!role && !isHidden(el.control) && accessibleName(el.control, role).indexOf(text) >= 0;
  }

  // -------------------------------------------------------------- state

  function isFileInput(el) {
    return el.tagName === 'INPUT' && el.type === 'file';
  }

  const NOT_TYPED_INTO = ['button', 'submit', 'reset', 'image', 'range', 'color', 'hidden'];

  /**
   * What kind of input a control takes, so text is only ever typed into a
   * text field. Decided from what the element is, never from the role it
   * claims: a button marked role="textbox" is still a button, and typing
   * begins with a click.
   */
  function controlOf(el) {
    const tag = el.tagName;
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA' || el.isContentEditable) return 'text';
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'file') return 'file';
      return NOT_TYPED_INTO.indexOf(type) >= 0 ? 'other' : 'text';
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'checkbox' || role === 'switch') return 'checkbox';
    if (role === 'radio') return 'radio';
    return 'other';
  }

  /** Is `inner` inside `outer` as the page is drawn: through slots and out of shadow roots. */
  function drawnInside(outer, inner) {
    for (let n = inner; n; n = n.assignedSlot || n.parentNode || n.host) if (n === outer) return true;
    return false;
  }

  /**
   * Where a frame's content starts, in its parent document's coordinates.
   * The frame's own border and padding sit between its border box and its
   * content origin, and both count toward the child's offset.
   */
  function contentOrigin(frame) {
    const fb = frame.getBoundingClientRect();
    const cs = frame.ownerDocument.defaultView.getComputedStyle(frame);
    return {
      x: fb.x + parseFloat(cs.borderLeftWidth || '0') + parseFloat(cs.paddingLeft || '0'),
      y: fb.y + parseFloat(cs.borderTopWidth || '0') + parseFloat(cs.paddingTop || '0'),
    };
  }

  /** The innermost element drawn at a point, looking into shadow roots. */
  function drawnAt(doc, x, y) {
    let hit = doc.elementFromPoint(x, y);
    for (let guard = 0; hit && hit.shadowRoot && guard < 10; guard++) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  /** Is a hit on `hit` as good as a hit on `el`: itself, a part of it, its label, or its styled stand-in. */
  function standsFor(el, hit) {
    if (hit === el || drawnInside(hit, el)) return true;
    // A control of its own inside it, such as a card's Follow button, would be pressed instead.
    if (drawnInside(el, hit)) return !controlWithin(el, hit);
    const label = hit.closest ? hit.closest('label') : null;
    if (label && (label.control === el || label.contains(el))) return true;
    // A checkbox, radio or file input is often hidden behind a drawn box
    // that sits beside it. That box may take the click; another control may
    // not, however close a sibling it is.
    const type = el.tagName === 'INPUT' ? (el.type || '').toLowerCase() : '';
    if (type !== 'checkbox' && type !== 'radio' && type !== 'file') return false;
    const parent = el.parentElement;
    const doc = el.ownerDocument;
    if (!parent || parent === doc.body || parent === doc.documentElement || !parent.contains(hit)) return false;
    for (let n = hit; n && n !== parent; n = n.parentElement) {
      if (INTERACTIVE.has(roleOf(n))) return false;
    }
    return true;
  }

  const PRESSABLE = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio']);

  /** A pressable control between `hit` and `el`, `hit` included and `el` not. */
  function controlWithin(el, hit) {
    for (let n = hit; n && n !== el; n = n.assignedSlot || n.parentNode || n.host) {
      if (n.nodeType === 1 && PRESSABLE.has(roleOf(n))) return true;
    }
    return false;
  }

  /**
   * The element a click at this one's centre would really land on, when it is
   * something else: a dialog or banner that appeared over it since it was
   * observed. Looked for in the element's own document and then, frame by
   * frame, in each document that holds it, since a banner on the page covers
   * a button in a frame just as well.
   */
  function covering(el) {
    const r = el.getBoundingClientRect();
    let x = r.x + r.width / 2;
    let y = r.y + r.height / 2;
    let target = el;
    for (let guard = 0; guard < 10; guard++) {
      const doc = target.ownerDocument;
      const hit = drawnAt(doc, x, y);
      if (hit && !standsFor(target, hit)) return hit;
      const frame = doc.defaultView && doc.defaultView.frameElement;
      if (!frame) return null;
      const origin = contentOrigin(frame);
      x += origin.x;
      y += origin.y;
      target = frame;
    }
    return null;
  }

  const isChoice = (el) => el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio');

  /** A checkbox or radio hidden by opacity or clipping behind a box a person sees. */
  function isStyledChoice(el) {
    if (!isChoice(el) || el.hidden) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.hidden || p.getAttribute('aria-hidden') === 'true') return false;
      const ps = getComputedStyle(p);
      if (ps.display === 'none' || ps.visibility === 'hidden') return false;
    }
    return hasStandIn(el);
  }

  /**
   * Only something a person can see stands for a hidden choice: a label, or
   * a box drawn beside it. With neither, it is a trap for software (a honeypot).
   */
  function hasStandIn(el) {
    if (drawnLabel(el)) return true;
    const box = el.parentElement;
    if (!box || box.querySelectorAll('input, select, textarea, button').length > 1) return false;
    for (const c of box.children) if (c !== el && drawn(c)) return true;
    return false;
  }

  /** A checkbox or radio drawn at no size with nothing drawn for it: nobody can see or answer it. */
  function unseenChoice(el) {
    if (!isChoice(el)) return false;
    const r = el.getBoundingClientRect();
    return (r.width === 0 || r.height === 0) && !hasStandIn(el);
  }

  function drawn(n) {
    if (isHidden(n)) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** The label a person sees for this input, if one is drawn. */
  function drawnLabel(el) {
    const label = (el.labels && el.labels[0]) || el.closest('label');
    return label && drawn(label) ? label : null;
  }

  /**
   * Does this hidden subtree contain a file input?
   *
   * Only ever asked about elements that are already hidden, so it does not
   * run on the common path. Native querySelector, and hidden subtrees that
   * matter are small.
   */
  function hidesAFileInput(el) {
    try {
      return typeof el.querySelector === 'function' && !!el.querySelector('input[type="file"]');
    } catch {
      return false;
    }
  }

  function isHidden(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el.hasAttribute('hidden')) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (typeof el.checkVisibility === 'function') {
      if (el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      // display: contents gives an element no box of its own, which reads as
      // not visible, yet everything inside it is drawn. Slots are like this,
      // and so are the wrapper elements many pages are built from.
      return getComputedStyle(el).display !== 'contents';
    }
    const style = getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
  }

  const ERROR_WORDS = /\b(invalid|required|enter|must|please|error|too (long|short)|not (a|valid)|whole number|decimal|between)\b/i;

  const ERROR_SHOWN = '[role=alert], [aria-live=assertive], [class*="error" i], [class*="invalid" i]';

  /** Marked invalid by the page, or by the browser once someone has touched it. */
  function isInvalid(el) {
    if (el.getAttribute('aria-invalid') === 'true') return true;
    try { return el.matches(':user-invalid'); } catch { return false; }
  }

  function refTargets(el, attr) {
    const ids = (el.getAttribute(attr) || '').trim();
    if (!ids) return [];
    const root = el.getRootNode();
    const out = [];
    for (const id of ids.split(/\s+/)) {
      let t = null;
      try { t = root.getElementById ? root.getElementById(id) : document.getElementById(id); } catch { t = null; }
      if (t) out.push(t);
    }
    return out;
  }

  /**
   * The message a form shows against one field ("Invalid input", "Enter a
   * whole number"), so the field that needs another answer is plain. Only
   * when it really is one: the field is marked invalid, or an alert or error
   * element is tied to it. Help text a field points to ("Please enter the
   * email you check most") is not an error, whatever its words.
   */
  function fieldError(el) {
    const invalid = isInvalid(el);
    // When the page marked it, its message is what the field points to; when only the browser did, it is the browser's.
    const pageSaid = el.getAttribute('aria-invalid') === 'true';
    if (invalid) {
      for (const t of refTargets(el, 'aria-errormessage')) {
        const s = isHidden(t) ? '' : clean(textFrom(t, 0));
        if (s) return s.slice(0, 160);
      }
    }
    for (const t of refTargets(el, 'aria-describedby')) {
      if (isHidden(t)) continue;
      const shown = t.matches(ERROR_SHOWN) ? t : t.querySelector(ERROR_SHOWN);
      const s = shown && !isHidden(shown) ? clean(textFrom(shown, 0)) : '';
      if (s) return s.slice(0, 160);
      const said = pageSaid ? clean(textFrom(t, 0)) : '';
      if (said && ERROR_WORDS.test(said)) return said.slice(0, 160);
    }
    let box = el.parentElement;
    for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
      if (box.querySelectorAll('input:not([type=hidden]), select, textarea').length > 1) break;
      const shown = box.querySelector('[role=alert], [class*="error" i], [class*="invalid" i]');
      if (shown && shown !== el && !shown.contains(el) && !isHidden(shown)) {
        const t = clean(shown.textContent);
        if (t && t.length <= 160 && ERROR_WORDS.test(t)) return t;
      }
    }
    return invalid && el.validationMessage ? clean(el.validationMessage).slice(0, 160) : '';
  }

  function stateOf(el, role) {
    const s = {};
    const aria = (n) => el.getAttribute('aria-' + n);

    const disabled = el.disabled === true || aria('disabled') === 'true';
    if (disabled) s.disabled = true;

    if (role === 'checkbox' || role === 'radio' || role === 'switch' ||
        role === 'menuitemcheckbox' || role === 'menuitemradio') {
      const a = aria('checked');
      if (a === 'mixed') s.checked = 'mixed';
      else if (a === 'true') s.checked = true;
      else if (a === 'false') s.checked = false;
      else if (typeof el.checked === 'boolean') s.checked = el.checked;
    }

    // A toggle answer ("Yes" pressed, "No" not) is a choice like a radio's.
    const pressed = aria('pressed');
    if (pressed === 'true') s.pressed = true;
    else if (pressed === 'false') s.pressed = false;

    const expanded = aria('expanded');
    if (expanded === 'true') s.expanded = true;
    else if (expanded === 'false') s.expanded = false;

    if (aria('selected') === 'true' || el.selected === true) s.selected = true;
    if (el.required === true || aria('required') === 'true') s.required = true;
    if (isInvalid(el)) s.invalid = true;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || role === 'textbox' || role === 'combobox') {
      const error = fieldError(el);
      if (error) { s.error = error; s.invalid = true; }
    }

    if (role === 'heading') {
      const lvl = aria('level');
      s.level = lvl ? Number(lvl) : Number(el.tagName.slice(1)) || 2;
    }
    return s;
  }

  function valueOf(el, role) {
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      // A search-style dropdown (react-select, as Greenhouse uses) keeps only
      // the typing in its input; the choice is drawn beside it.
      if (role === 'combobox' && !el.value) return chosenBeside(el);
      if (t === 'password') return el.value ? '••••••' : '';
      if (t === 'checkbox' || t === 'radio' || t === 'button' || t === 'submit') return '';
      if (t === 'file') return el.files ? clean([...el.files].map((f) => f.name).join(', ')) : '';
      return clean(el.value);
    }
    if (tag === 'TEXTAREA') return clean(el.value);
    if (tag === 'SELECT') {
      // An option worth nothing is the "Select one" prompt: nothing is chosen.
      if (el.value === '') return '';
      const opt = el.options && el.options[el.selectedIndex];
      const t = opt ? clean(opt.textContent) : '';
      return el.selectedIndex === 0 && PROMPT.test(t) ? '' : t;
    }
    // A dropdown built from divs shows its choice as text, not as a value.
    if (role === 'combobox' && !el.querySelector('[role=listbox],[role=option]')) {
      const t = clean(el.textContent);
      return PROMPT.test(t) ? '' : t;
    }
    if (role === 'slider' || role === 'spinbutton' || role === 'progressbar') {
      return clean(el.getAttribute('aria-valuenow') || el.value || '');
    }
    if (el.isContentEditable) return clean(el.textContent);
    return '';
  }

  // A closed dropdown draws none of its options, so the visibility walk never
  // reaches them, and without the list an agent can only guess what to pick.
  function optionsOf(el) {
    if (el.tagName !== 'SELECT' || !el.options) return undefined;
    const out = [];
    for (const o of el.options) {
      const t = o.disabled ? '' : clean(o.textContent);
      if (t) out.push(t);
      if (out.length >= MAX_OPTIONS) break;
    }
    return out.length ? out : undefined;
  }

  function chosenBeside(input) {
    let box = input.parentElement;
    for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
      if (box.querySelectorAll('input:not([type=hidden]), select, textarea').length > 1) return '';
      if (box.querySelector('[role=listbox], [role=option]')) return '';
      // Past the field's own box: its question, or the header it sits in.
      if (box.querySelector('label, legend, h1, h2, h3, h4, h5, h6, a[href], nav, [role=navigation]')) return '';
      const t = clean(box.innerText || '');
      if (t) return PROMPT.test(t) || t.length > 120 ? '' : t;
    }
    return '';
  }

  function ownText(el, max) {
    // Text that belongs to this node rather than a descendant we will emit
    // separately. Keeps the tree from repeating the same sentence at
    // every level of nesting.
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) out += node.nodeValue;
    }
    return clean(out, max);
  }

  /** The job a result card or job link is about: the id the page keeps on it, or the one in its address. */
  function jobIdOf(el, role) {
    const id = el.getAttribute('data-job-id') || el.getAttribute('data-occludable-job-id') || el.getAttribute('data-jk');
    if (id) return /^[\w-]{4,40}$/.test(id) ? id : '';
    if (role !== 'link') return '';
    const m = /\/jobs\/view\/(\d{5,})|[?&](?:currentJobId|jk)=(\w{5,40})/.exec(el.getAttribute('href') || '');
    return m ? m[1] || m[2] : '';
  }

  /** Text that asks something: it ends in a question mark, or answers follow it. */
  function asks(el, t) {
    if (/[?？]\s*[*✱]?\s*$/.test(t)) return true;
    for (let n = el, i = 0; n && i < 3; n = n.parentElement, i++) {
      const next = n.nextElementSibling;
      if (next) return next.matches(CONTROLS) || !!next.querySelector(CONTROLS);
    }
    return false;
  }

  // --------------------------------------------------------------- walk

  function install() {
    const api = {
      version: VERSION,
      stateId: null,
      refs: new Map(),
      meta: new Map(),
      observe,
      describe,
      // How this page's elements are named, for whoever needs to name one that was not observed.
      identify: function (el) {
        const role = roleOf(el);
        return role ? { role: role, name: accessibleName(el, role) } : null;
      },
    };

    // An element keeps its ref for as long as its document lives, and a new
    // document carries the numbering on from the last one (refBase), so a
    // ref from an earlier look can never come to mean a different element.
    const known = new WeakMap();
    let minted = 0;

    function mintStateId() {
      return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function observe(options) {
      const opts = options || {};
      const interactiveOnly = !!opts.interactive;
      const viewportOnly = !!opts.viewportOnly;
      const started = performance.now();

      if (opts.refBase > minted) minted = opts.refBase;
      const stateId = mintStateId();
      const refs = new Map();
      const meta = new Map();
      const nodes = [];
      let truncated = false;
      // Generic leaf text is useful but unbounded by nature, so it gets its
      // own budget rather than competing with the structural nodes.
      let textBudget = GENERIC_TEXT_BUDGET;
      let truncationReason = null;
      let frameCounter = 0;
      // An open list of 200 countries would push the rest of the form out of
      // the budget; past its first options, the list is only counted.
      const optionCounts = new Map();
      const optionOverflow = new Map();

      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;

      function inViewport(el) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
      }

      let askBudget = ASK_BUDGET;
      let paragraphBudget = PARAGRAPH_BUDGET;
      // A long text is kept whole when it asks something, and otherwise
      // while the snapshot's allowance for long paragraphs lasts.
      function sized(el, t) {
        if (t.length <= MAX_TEXT) return t;
        if (askBudget > 0 && asks(el, t)) {
          const s = clean(t, MAX_LONG);
          askBudget -= s.length - MAX_TEXT;
          return s;
        }
        if (paragraphBudget > 0) {
          const s = clean(t, Math.min(MAX_LONG, MAX_TEXT + paragraphBudget));
          paragraphBudget -= s.length - MAX_TEXT;
          return s;
        }
        return clean(t);
      }

      // `within` is the name of the nearest emitted ancestor. Text that name
      // already carries is not said a second time by the nodes under it.
      // `job` is the job a result card is about, said once, on the card.
      function visit(el, depth, nested, within, job) {
        if (nodes.length >= MAX_NODES) {
          truncated = true;
          // Which budget ran out, so a caller can narrow the right thing
          // rather than guessing why the page came back incomplete.
          truncationReason = truncationReason || ('node budget of ' + MAX_NODES + ' reached');
          return;
        }
        if (el.nodeType !== 1) return;
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ||
            tag === 'TEMPLATE' || tag === 'HEAD' || tag === 'META' || tag === 'LINK') return;
        // Fanfold's own "working here" indicator is Fanfold's, never the page's.
        if (tag === INDICATOR_TAG) return;
        // File inputs are the one control that is SUPPOSED to be invisible.
        // Practically every real application form hides the input and puts a
        // styled button in front of it, so the ordinary visibility filter
        // meant the agent could see the button it must not click and not the
        // input it needs. A hidden one is still emitted, and still refuses a
        // click — describe() checks visibility separately — but it can be
        // named as the target of an upload.
        if (isHidden(el)) {
          // A checkbox or radio drawn as a custom box keeps its real input,
          // hidden only by opacity or clipping: it is still the control.
          if (isStyledChoice(el)) { /* emitted below, like any control */ }
          else if (!isFileInput(el) && !hidesAFileInput(el)) return;
          else if (!isFileInput(el)) {
            // A hidden WRAPPER: walk into it for the input, but do not emit
            // the wrapper or anything else inside it.
            for (let c = el.firstElementChild; c; c = c.nextElementSibling) visit(c, depth, nested, within, job);
            return;
          }
        }
        if (unseenChoice(el)) return;

        let role = roleOf(el);
        // A radio drawn around a real one (Workable) is one answer, said once, by the real input.
        if ((role === 'radio' || role === 'checkbox') && tag !== 'INPUT') {
          const inner = el.querySelector('input[type=radio], input[type=checkbox]');
          if (inner && (!isHidden(inner) || isStyledChoice(inner))) role = null;
        }
        if (role === 'option') {
          const list = el.closest('[role=listbox]') || el.parentElement;
          const seen = (optionCounts.get(list) || 0) + 1;
          optionCounts.set(list, seen);
          if (seen > MAX_LIST_OPTIONS) {
            let more = optionOverflow.get(list);
            if (!more) {
              more = { node: { ref: null, role: 'text', name: null, value: null, text: '', depth, state: nested ? { nested: true, frame: nested.id } : {} }, n: 0 };
              optionOverflow.set(list, more);
              nodes.push(more.node);
            }
            more.n++;
            return;
          }
        }
        const ownJob = jobIdOf(el, role);
        if (ownJob && (!job || job.id !== ownJob)) job = { id: ownJob, shown: false };
        let emitted = false;
        let cover = within;

        if (role) {
          const interactive = INTERACTIVE.has(role);
          const wanted = interactive || (!interactiveOnly && CONTENT.has(role));
          const visible = !viewportOnly || inViewport(el);

          if (wanted && visible) {
            const name = accessibleName(el, role);
            const value = valueOf(el, role);
            let text = interactive ? '' : sized(el, ownText(el, Infinity));
            // A heading's name IS its text. Emitting both doubles the cost of
            // every content node for no added information.
            if (text && text === name) text = '';
            // A line of a card whose name already says it.
            const says = name || text;
            const repeats = (role === 'paragraph' || role === 'listitem') && within && says && !value &&
              within.indexOf(says) >= 0 && (!text || within.indexOf(text) >= 0);

            // A structural node with nothing to say is noise.
            const worthEmitting = !repeats && (interactive || name || value || text);
            if (worthEmitting) {
              // Only actuating controls need evidence; everything else would
              // pay tokens and CPU for facts nobody asks about.
              const evidence = interactive ? evidenceFor(el) : undefined;
              const state = stateOf(el, role);
              if (nested) { state.nested = true; if (nested.id) state.frame = nested.id; }
              if (job && !job.shown) { state.job = job.id; job.shown = true; }
              let ref = null;
              if (interactive || (name && CONTENT.has(role))) {
                ref = known.get(el);
                if (!ref) { ref = 'e' + ++minted; known.set(el, ref); }
                refs.set(ref, el);
                meta.set(ref, { role, name, evidence, disabled: !!state.disabled });
              }
              const node = {
                ref, role,
                name: name || null,
                value: value || null,
                text: text || null,
                depth, state, evidence,
              };
              const options = optionsOf(el);
              if (options) node.options = options;
              nodes.push(node);
              emitted = true;
              if (name && namedByItsText(el, role, name)) cover = name;
            }
          }
        }

        // Text in an unrecognised container is where most of the meaning
        // lives on ordinary sites — job descriptions, SPA result rows. A
        // serializer that emits only known roles goes blind to them.
        if (!emitted && !role && !interactiveOnly && textBudget > 0) {
          const t = sized(el, leafText(el, Infinity));
          if (t && !(within && within.indexOf(t) >= 0) && !namesItsControl(el, t) && (!viewportOnly || inViewport(el))) {
            textBudget--;
            nodes.push({
              ref: null, role: 'text', name: null, value: null, text: t,
              depth, state: nested ? { nested: true, frame: nested.id } : {},
            });
          }
        }

        const childDepth = emitted ? depth + 1 : depth;

        // Open shadow roots are part of the page as far as the user is
        // concerned. Closed ones are not reachable and we do not try.
        if (el.shadowRoot) {
          for (const child of el.shadowRoot.children) visit(child, childDepth, nested || { id: 'shadow' }, cover, job);
        }

        if (tag === 'IFRAME' || tag === 'FRAME') {
          let doc = null;
          try { doc = el.contentDocument; } catch { doc = null; }
          if (doc && doc.body) {
            // Frame identity, so a caller can tell which document a node came
            // from — 'nested' alone does not distinguish two frames.
            const frameId = 'f' + ++frameCounter;
            const frameName = el.getAttribute('name') || el.getAttribute('title') || '';
            let frameSrc = '';
            try { frameSrc = new URL(el.src, location.href).origin; } catch { frameSrc = ''; }
            visit(doc.body, childDepth, { id: frameId, name: frameName, origin: frameSrc }, '', null);
          } else if (el.src) {
            // A cross-origin frame is invisible to us. Saying so is better
            // than a silent hole in the page. Its whole address, never cut:
            // an embedded application form (Greenhouse on a company site) is
            // opened there directly, and its token runs to hundreds of characters.
            let address = '';
            try { address = new URL(el.src, location.href).href; } catch { address = el.src; }
            const title = clean(el.getAttribute('title') || el.getAttribute('name') || '');
            nodes.push({ ref: null, role: 'frame', name: title || null, value: null, text: address, depth, state: { nested: true } });
          }
          return;
        }

        for (const child of el.children) visit(child, childDepth, nested, cover, job);
      }

      const root = document.body || document.documentElement;
      if (root) visit(root, 0, null, '', null);
      for (const more of optionOverflow.values()) more.node.text = '… and ' + more.n + ' more options: type in the field to narrow the list';

      api.stateId = stateId;
      api.refs = refs;
      api.meta = meta;

      return {
        stateId,
        url: location.href,
        title: document.title || '',
        ready: document.readyState,
        nodes,
        walkMs: Math.round((performance.now() - started) * 10) / 10,
        truncated,
        truncationReason,
        frames: frameCounter,
        refHigh: minted,
      };
    }

    /**
     * Resolve a ref for an action. Returns a typed failure rather than a
     * throw so the Node side can classify without string matching.
     */
    function resolve(stateId, ref) {
      if (api.stateId !== stateId) {
        return { ok: false, failure: 'STALE_STATE', detail: 'observation ' + stateId + ' superseded by ' + api.stateId };
      }
      const el = api.refs.get(ref);
      if (!el) return { ok: false, failure: 'UNKNOWN_REF', detail: ref + ' not in current observation' };
      if (!el.isConnected) return { ok: false, failure: 'NOT_ACTIONABLE', detail: 'element detached from document' };

      const recorded = api.meta.get(ref) || {};
      const role = roleOf(el);
      const name = accessibleName(el, role);

      // Role and name are not enough. A link whose destination changed, a
      // button that became a submit, or a text input that became a password
      // field is a different action wearing the same label — which is exactly
      // the substitution a drift check exists to catch.
      // A control that was disabled when observed and is enabled now is a
      // different action: the policy engine treats disabled as harmless
      // precisely because it cannot actuate.
      const nowDisabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
      if (recorded.disabled === true && !nowDisabled) {
        return { ok: false, failure: 'TARGET_DRIFT', detail: 'the control was disabled when observed and is now enabled' };
      }

      const nowEvidence = evidenceFor(el);
      const wasEvidence = recorded.evidence || {};
      for (const key of ['destOrigin', 'scheme', 'formActionOrigin', 'formMethod', 'inputType', 'isSubmit']) {
        if (wasEvidence[key] !== undefined && wasEvidence[key] !== nowEvidence[key]) {
          return {
            ok: false, failure: 'TARGET_DRIFT',
            detail: key + ' changed from ' + JSON.stringify(wasEvidence[key]) + ' to ' + JSON.stringify(nowEvidence[key]),
          };
        }
      }

      if (role !== recorded.role || name !== recorded.name) {
        return {
          ok: false, failure: 'TARGET_DRIFT',
          detail: 'observed ' + recorded.role + ' "' + recorded.name + '", now ' + role + ' "' + name + '"',
        };
      }
      // A box drawn over its real input acts through that input or its label.
      if (isHidden(el) && !isStyledChoice(el)) return { ok: false, failure: 'NOT_ACTIONABLE', detail: 'element is not visible' };
      if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') {
        return { ok: false, failure: 'NOT_ACTIONABLE', detail: 'element is disabled' };
      }
      return { ok: true, role, name };
    }

    /**
     * Element geometry in TOP-LEVEL page coordinates.
     *
     * getBoundingClientRect() is relative to the element's own document, so an
     * element inside an iframe reports coordinates relative to that frame. We
     * dispatch synthesized input at top-level coordinates, so without this
     * walk every click inside a frame lands somewhere else on the page
     * entirely — and, worse, lands on whatever happens to be there.
     */
    function absoluteBox(el) {
      const b = el.getBoundingClientRect();
      let x = b.x;
      let y = b.y;
      let win = el.ownerDocument.defaultView;
      let guard = 0;
      while (win && win !== window && win.frameElement && guard++ < 10) {
        const origin = contentOrigin(win.frameElement);
        x += origin.x;
        y += origin.y;
        win = win.parent;
      }
      return { x, y, width: b.width, height: b.height };
    }

    /** Scroll the element, and every frame containing it, into view. */
    function scrollIntoViewDeep(el) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      let win = el.ownerDocument.defaultView;
      let guard = 0;
      while (win && win !== window && win.frameElement && guard++ < 10) {
        win.frameElement.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        win = win.parent;
      }
    }

    /** resolve + scroll + geometry, in one round trip. */
    function describe(stateId, ref) {
      const r = resolve(stateId, ref);
      if (!r.ok) return r;
      const el = api.refs.get(ref);
      scrollIntoViewDeep(el);
      const box = absoluteBox(el);
      if (box.width === 0 || box.height === 0) {
        // A checkbox drawn at no size beside its label (LinkedIn's Follow) is
        // worked through the label a person sees.
        const control = controlOf(el);
        if ((control === 'checkbox' || control === 'radio') && el.tagName === 'INPUT' && drawnLabel(el)) {
          return { ok: true, role: r.role, name: r.name, box: box, control: control, coveredBy: null, viaLabel: true };
        }
        return { ok: false, failure: 'NOT_ACTIONABLE', detail: 'element has zero size' };
      }
      const over = covering(el);
      const overRole = over ? roleOf(over) : null;
      return {
        ok: true, role: r.role, name: r.name, box: box,
        control: controlOf(el),
        coveredBy: over
          ? ((overRole || over.tagName.toLowerCase()) + ' "' + (overRole ? accessibleName(over, overRole) : clean(over.textContent || '')).slice(0, 60) + '"')
          : null,
      };
    }

    window.__ba = api;
  }

  install();
})();
