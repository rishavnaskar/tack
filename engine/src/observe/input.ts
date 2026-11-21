/**
 * Input that reaches the page the way a person's would: trusted mouse and
 * keyboard events through the Input domain, rather than element.click(),
 * which skips hit-testing and will happily "click" an element under a modal.
 */

import type { ActionRequest } from '../types.ts';
import { keyEvents, knownKey } from './keyboard.ts';
import { ActionFailureError } from './page-errors.ts';
import { fence } from '../policy/untrusted.ts';
import type { ControlKind } from './serializer.ts';
import { chooseOption, focusedSearch, listedOptions, optionChosen, optionPoint, pickerState, shownCount } from './pick.ts';

/** What input needs from the page: send a CDP command, or evaluate in it. */
export interface InputPort {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  /** The input is in; what follows only reads the page, so another tab may take its turn. */
  inputDone?(): void;
  /** Let another tab take its turn while `wait` only reads the page, then take the turn back, with this tab in front again. */
  inputAside?<W>(wait: () => Promise<W>): Promise<W>;
}

/** Waiting on the page alone: other tabs are not held up behind it when the port allows. */
function waiting<W>(port: InputPort, wait: () => Promise<W>): Promise<W> {
  return port.inputAside ? port.inputAside(wait) : wait();
}

export interface InputTarget {
  role: string;
  box: { x: number; y: number; width: number; height: number };
  control: ControlKind;
  coveredBy: string | null;
  /** Drawn at no size: clicked through its visible label, never at its own spot. */
  viaLabel?: boolean;
}

/** Actions that begin with a real click at the element's centre. */
const CLICKS = new Set(['click', 'check', 'uncheck', 'fill', 'type']);

/**
 * Why text cannot go into this control. Typing begins with a click, so
 * without this a "fill" aimed at a button would press it, and one aimed at a
 * dropdown would put the text into whichever field had focus.
 */
function whyNotTyped(target: InputTarget): string | null {
  switch (target.control) {
    case 'text': return null;
    case 'select': return 'this is a dropdown, not a text field: use select with the label of the option';
    case 'checkbox': return 'this is a checkbox, not a text field: use check or uncheck';
    case 'radio': return 'this is a radio button, not a text field: use check';
    case 'file': return 'this takes a file, not text: attach one of the user\'s files with upload';
    default:
      return target.role === 'combobox' || target.role === 'listbox'
        ? `the ${target.role} is a dropdown made of page elements, not a text field: use select with the option's text, and its option is chosen`
        : `the ${target.role} is not a text field, so nothing was typed and it was not clicked`;
  }
}

/** What a check or uncheck aimed at a control that is not a box is told to use instead. */
const NOT_A_BOX: Partial<Record<ControlKind, string>> = {
  text: 'this is a text field, not a checkbox: use fill with the text',
  select: 'this is a dropdown, not a checkbox: use select with the label of the option',
  file: 'this takes a file, not a tick: attach one of the user\'s files with upload',
};

/** A click at the element's centre would land on whatever has come to sit over it. */
function covered(by: string): ActionFailureError {
  return new ActionFailureError('NOT_ACTIONABLE', `covered by ${JSON.stringify(fence(by))}, so a click here would land on that instead`);
}

function notADropdown(role: string): ActionFailureError {
  return new ActionFailureError('NOT_ACTIONABLE', `the ${role} is not a dropdown with fixed options: click it, then click the option`);
}

/** Delete, pressed: it empties whatever the field has selected. */
async function pressDelete(port: InputPort): Promise<void> {
  for (const type of ['keyDown', 'keyUp']) {
    await port.send('Input.dispatchKeyEvent', { type, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  }
}

/**
 * Carry out the action on the resolved element. Returns what was done when
 * it is more than the request said: the option a list was answered with.
 */
export async function dispatchOnTarget(port: InputPort, req: ActionRequest, target: InputTarget): Promise<string | void> {
  const x = target.box.x + target.box.width / 2;
  const y = target.box.y + target.box.height / 2;

  if (req.kind === 'fill' || req.kind === 'type') {
    // Typing never clicks what is not a text field, whatever role it claims: choosing from a list is select's.
    const why = whyNotTyped(target);
    if (why) throw new ActionFailureError('NOT_ACTIONABLE', why);
  }
  if (req.kind === 'select' && target.control !== 'select') {
    if (target.control === 'text' || target.control === 'other') return pickOption(port, req, target);
    throw notADropdown(target.role);
  }
  // The policy judged the element that was observed. A click lands on
  // whatever is on top, so if something has come to sit over it, stop.
  if (CLICKS.has(req.kind) && target.coveredBy) throw covered(target.coveredBy);

  switch (req.kind) {
    case 'hover':
      await port.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      return;

    case 'click':
      if (target.viaLabel) {
        await clickAt(port, ...await labelAt(port, req.ref));
        return;
      }
      await clickAt(port, x, y);
      return;

    case 'check':
    case 'uncheck': {
      // Ticking is for a box: a field that takes text, an option or a file is pointed at what it does take.
      const notABox = NOT_A_BOX[target.control];
      if (notABox) throw new ActionFailureError('NOT_ACTIONABLE', `${notABox}; nothing was changed`);
      const want = req.kind === 'check';
      const checked = (): Promise<boolean> => port.evaluate<boolean>(`(() => {
        const el = window.__ba.refs.get(${JSON.stringify(req.ref)});
        return typeof el.checked === 'boolean' ? el.checked : el.getAttribute('aria-checked') === 'true';
      })()`);
      if (await checked() === want) return;
      if (!target.viaLabel) {
        await clickAt(port, x, y);
        if (await checked() === want) return;
      }
      // A styled box is drawn over its real input, which is hidden or tiny:
      // what a person clicks is the label. Then it is checked, not assumed.
      const label = await findLabel(port, req.ref);
      if (label && 'blocked' in label) throw blockedBy(label.blocked);
      if (label) {
        await clickAt(port, label.x, label.y);
        if (await checked() === want) return;
      }
      throw new ActionFailureError('NOT_ACTIONABLE', `it did not change: it is still ${want ? 'unchecked' : 'checked'}`);
    }

    case 'fill':
    case 'type': {
      const refused = await port.evaluate<string | null>(notWritable(req)).catch(() => null);
      if (typeof refused === 'string' && refused) throw new ActionFailureError('NOT_ACTIONABLE', `nothing was typed: ${refused}`);
      if (await setWholeValue(port, req)) return;
      await clickAt(port, x, y);
      if (req.kind === 'fill') {
        /*
         * Select everything the field holds, then insert: insertText
         * replaces a selection, and the field's own change detection runs
         * exactly as it would for a person typing. Setting .value directly
         * is invisible to React's synthetic event system.
         *
         * The selection is made on the element itself rather than with a
         * select-all shortcut. Meta+a through Input.dispatchKeyEvent never
         * reaches a headless renderer as an editing command, so the Delete
         * that followed it deleted nothing and the new text was APPENDED to
         * the old — found on a real page, where an edited approval would
         * have sent the draft and the edit run together.
         */
        const selected = await port.evaluate<boolean>(`(() => {
          const el = window.__ba && window.__ba.refs.get(${JSON.stringify(req.ref)});
          if (!el) return false;
          el.focus();
          if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
            try {
              el.setSelectionRange(0, el.value.length);
            } catch {
              // Number and email fields refuse a range but select whole.
              el.select();
            }
            return true;
          }
          if (el.isContentEditable) {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            sel.removeAllRanges();
            sel.addRange(range);
            return true;
          }
          return false;
        })()`).catch(() => false);
        if (!selected) await pressKey(port, 'Meta+a');
        // Clears the selection when there is nothing to insert (an empty
        // fill means "empty the field"); harmless when the insert follows.
        await pressDelete(port);
      }
      if (req.value) {
        await port.send('Input.insertText', { text: req.value });
        port.inputDone?.();
        await awaitSuggestions(port, req.ref);
      }
      if (req.kind === 'fill') await makeItHold(port, req.ref, req.value ?? '');
      return;
    }

    case 'select': {
      if (req.value === undefined) throw new Error('select requires a value');
      // Exact value, exact text, then the same text ignoring case and spacing.
      // Nothing looser: "No" must never land on "Not sure".
      const picked = await port.evaluate<{ ok: boolean; near: string[] }>(`(() => {
        const el = window.__ba.refs.get(${JSON.stringify(req.ref)});
        const want = ${JSON.stringify(req.value)};
        const squash = (s) => s.replace(/\\s+/g, ' ').trim().toLowerCase();
        // What the snapshot shows is each option's text, so text decides first;
        // the hidden value only when no text matches. Disabled options are never sent.
        const all = [...el.options].filter(o => !o.disabled);
        const opt = all.find(o => o.textContent.trim() === want) || all.find(o => squash(o.textContent) === squash(want))
          || all.find(o => o.value === want);
        if (!opt) {
          const w = squash(want);
          const near = all.map(o => o.textContent.replace(/\\s+/g, ' ').trim())
            .filter(t => t && w && (squash(t).includes(w) || w.includes(squash(t))));
          return { ok: false, near: near.slice(0, 8).map(t => t.slice(0, 80)) };
        }
        el.selectedIndex = opt.index;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, near: [] };
      })()`);
      if (!picked.ok) {
        // A long list shows only its start in the snapshot, so name the close ones.
        const near = picked.near.map((t) => JSON.stringify(fence(t))).join(', ');
        throw new ActionFailureError('NOT_ACTIONABLE', `no option matching ${JSON.stringify(req.value)}`
          + (near ? `; close ones on the page: ${near}` : '; the dropdown\'s options are listed on its line in the snapshot'));
      }
      return;
    }

    default:
      throw new Error(`unhandled target action ${req.kind}`);
  }
}

/** How long a list is given to show its options, after opening it or typing into it. */
const PICK_WAIT ={ optionsMs: 2_500, againMs: 1_200, shownMs: 1_500 };

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The options once the list stops changing, or what it shows when the wait runs out. */
async function settledOptions(port: InputPort, ref: string, maxMs: number): Promise<string[]> {
  const deadline = Date.now() + maxMs;
  let last: string[] | null = null;
  for (;;) {
    const now = await port.evaluate<string[]>(listedOptions(ref)).catch((): string[] => []);
    if (now.length && last && now.join('\n') === last.join('\n')) return now;
    if (Date.now() >= deadline) return now;
    last = now;
    await pause(100);
  }
}

/** Put this text in place of whatever the focused field holds. */
async function typeOver(port: InputPort, text: string): Promise<void> {
  await port.evaluate(`(() => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    for (let w = a && a.contentDocument; w; w = a && a.contentDocument) { a = w.activeElement; }
    if (a && typeof a.setSelectionRange === 'function' && typeof a.value === 'string') a.setSelectionRange(0, a.value.length);
  })()`).catch(() => undefined);
  await pressDelete(port);
  if (text) await port.send('Input.insertText', { text });
}

const quoteAll = (options: readonly string[], max = 25): string => {
  const shown = options.slice(0, max).map((o) => JSON.stringify(fence(o.slice(0, 80)))).join(', ');
  return options.length > max ? `${shown}, and ${options.length - max} more` : shown;
};

/**
 * Answer a list the page draws itself (a searchable dropdown, a combobox
 * made of divs, a field that suggests as you type) the way a person does:
 * open it, type the answer where it takes typing, wait for the options,
 * choose the one the answer means (see pick.ts), click it, and check the
 * field now shows it. When no option fits, the list is put back as it was and
 * the options it offers are named. A field that only suggests and shows no
 * list at all takes the text as it is.
 */
async function pickOption(port: InputPort, req: ActionRequest, target: InputTarget): Promise<string> {
  const ref = req.ref ?? '';
  const want = req.value ?? '';
  if (!want.trim()) throw new ActionFailureError('NOT_ACTIONABLE', 'say which option to choose');
  const state = await port.evaluate<{
    typed: boolean; value: string; expanded: boolean; list: boolean; presses: boolean; datalist: string[] | null; showing: string[]; inline?: boolean;
  } | null>(pickerState(ref));
  if (!state) throw new ActionFailureError('STALE_STATE', 'the field is no longer on the page');
  // Opening it is a click: on a button that submits or a link, that click would be the submit or the navigation.
  if (state.presses) {
    throw new ActionFailureError('NOT_ACTIONABLE', `the ${target.role} would submit a form or follow a link when clicked, so it was not opened`);
  }
  if (!state.list && target.control !== 'text') throw notADropdown(target.role);
  if (target.coveredBy) throw covered(target.coveredBy);
  // Chosen already: choosing it again changes nothing a check afterwards could see. What a field
  // that takes typing holds may be typed and never chosen, so only what is drawn beside it counts.
  const showing = state.typed ? state.showing.slice(1) : state.showing;
  if (!state.datalist && showing.some((t) => t && t.length <= want.length + 2 && chooseOption(want, [t]) !== null)) {
    return `${JSON.stringify(fence(want))} was already chosen`;
  }
  // A click on some widgets closes a list that is already open; a list box open in the page needs none (one would choose an option).
  if (!state.inline && (state.typed || !state.expanded)) await clickAt(port, target.box.x + target.box.width / 2, target.box.y + target.box.height / 2);
  if (state.typed && state.datalist) {
    // The browser draws these suggestions itself: the words go in as the suggestion that fits would put them, or as given.
    const fits = chooseOption(want, state.datalist);
    const words = fits && 'index' in fits ? state.datalist[fits.index] : want;
    await typeOver(port, words);
    port.inputDone?.();
    return words === want ? 'typed in as it is: its suggestions are the browser\'s own' : `typed in as the suggestion ${JSON.stringify(fence(words))}`;
  }
  const typed = state.typed || await port.evaluate<boolean>(focusedSearch(ref)).catch(() => false);
  if (typed) await typeOver(port, want);

  // A list that loads its options slowly holds no other tab's input while it does.
  let options = await waiting(port, () => settledOptions(port, ref, PICK_WAIT.optionsMs));
  const offered = options;
  let choice = chooseOption(want, options);
  // What was typed narrowed the list to nothing that fits: the whole list may still hold it, worded otherwise.
  if (!choice && typed) {
    await typeOver(port, '');
    options = await waiting(port, () => settledOptions(port, ref, PICK_WAIT.againMs));
    choice = chooseOption(want, options);
  }
  if (!choice || !('index' in choice)) {
    if (!options.length) options = offered;
    if (state.typed && !options.length) {
      // No list at all: a field that only suggests takes the words themselves.
      await typeOver(port, want);
      port.inputDone?.();
      return 'no list of options appeared, so the text was typed in as it is';
    }
    if (typed) await typeOver(port, state.typed ? state.value : '');
    await pressKey(port, 'Escape');
    port.inputDone?.();
    if (choice && 'ambiguous' in choice) {
      throw new ActionFailureError('NOT_ACTIONABLE',
        `${JSON.stringify(fence(want))} fits more than one option: ${quoteAll(choice.ambiguous)}. Give the exact text of the one meant; nothing was chosen`);
    }
    throw new ActionFailureError('NOT_ACTIONABLE', options.length
      ? `no option matches ${JSON.stringify(fence(want))}; nothing was chosen. The options it offers: ${quoteAll(options)}`
      : `no options appeared when it was opened${typed ? ' and typed into' : ''}; nothing was chosen`);
  }

  const chosen = options[choice.index];
  type Shown = { value: string | null; counts: number[] } | null;
  const before = await port.evaluate<Shown>(shownCount(ref, chosen)).catch(() => null);
  const point = await port.evaluate<{ x: number; y: number } | null>(optionPoint(choice.index)).catch(() => null);
  if (!point) {
    await pressKey(port, 'Escape');
    port.inputDone?.();
    throw new ActionFailureError('NOT_ACTIONABLE', `the option ${JSON.stringify(fence(chosen))} is covered or gone, so it was not clicked`);
  }
  await clickAt(port, point.x, point.y);
  port.inputDone?.();

  const words = chosen.replace(/\s+/g, ' ').trim().toLowerCase();
  const deadline = Date.now() + PICK_WAIT.shownMs;
  for (;;) {
    // A list box shows its choice on the option itself.
    if (state.inline && await port.evaluate<boolean>(optionChosen(ref, choice.index)).catch(() => false)) break;
    const after = await port.evaluate<Shown>(shownCount(ref, chosen)).catch(() => null);
    const listed = await port.evaluate<string[]>(listedOptions(ref)).catch((): string[] => []);
    const inValue = !!after?.value && after.value.includes(words) && (after.value !== before?.value || !listed.includes(chosen));
    const drawn = !!after && after.counts.some((n, i) => n > (before?.counts[i] ?? 0));
    if (inValue || drawn) break;
    if (Date.now() >= deadline) {
      throw new ActionFailureError('NOT_ACTIONABLE', `the option ${JSON.stringify(fence(chosen))} was clicked, but the field does not show it`);
    }
    await pause(100);
  }
  return `chose ${JSON.stringify(fence(chosen))}`;
}

/**
 * Why text must not go into this field: the page made it read-only or
 * disabled, or the text is longer than it takes. Setting the value directly
 * would get past all three, which a person typing never could.
 */
function notWritable(req: ActionRequest): string {
  return `(() => {
    const el = window.__ba && window.__ba.refs.get(${JSON.stringify(req.ref)});
    if (!el) return null;
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') return 'the field is disabled';
    if (el.readOnly === true || el.getAttribute('aria-readonly') === 'true') return 'the field is read-only';
    const max = typeof el.maxLength === 'number' ? el.maxLength : -1;
    const len = ${JSON.stringify(req.value ?? '')}.length + (${JSON.stringify(req.kind)} === 'type' && typeof el.value === 'string' ? el.value.length : 0);
    return max >= 0 && len > max ? 'the field takes at most ' + max + ' characters and this would be ' + len + ': shorten it' : null;
  })()`;
}

type LabelPoint = { x: number; y: number } | { blocked: 'link' | 'covered' } | null;

async function findLabel(port: InputPort, ref: string | undefined): Promise<LabelPoint> {
  const found = await port.evaluate<LabelPoint>(labelPoint(ref)).catch(() => null);
  return found && typeof found === 'object' ? found : null;
}

function blockedBy(why: 'link' | 'covered'): ActionFailureError {
  return new ActionFailureError('NOT_ACTIONABLE', why === 'covered'
    ? 'its label is covered by something else, so the label was not clicked'
    : 'its label holds a link or button wherever it could be clicked, so the label was not clicked');
}

/** Where to click a box drawn at no size: a point on its label, or a refusal. */
async function labelAt(port: InputPort, ref: string | undefined): Promise<[number, number]> {
  const label = await findLabel(port, ref);
  if (label && 'x' in label) return [label.x, label.y];
  throw label ? blockedBy(label.blocked) : new ActionFailureError('NOT_ACTIONABLE', 'element has zero size and no label to click');
}

/**
 * A point on the label's own words, in page coordinates, found by asking the
 * page what is drawn there: a click 10px into a label can land on a link or a
 * button inside it. Blocked when every such point is one of those.
 */
function labelPoint(ref: string | undefined): string {
  return `(() => {
    const el = window.__ba.refs.get(${JSON.stringify(ref)});
    const l = (el.labels && el.labels[0]) || el.closest('label');
    if (!l) return null;
    // The label lives where the content scrolls; the hidden input may not.
    l.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const doc = l.ownerDocument;
    const root = l.getRootNode();
    const at = (x, y) => (typeof root.elementFromPoint === 'function' ? root : doc).elementFromPoint(x, y);
    const acts = (n) => {
      for (let x = n; x && x !== l; x = x.parentElement) {
        if (x !== el && x.matches('a[href], button, iframe, frame, input, select, textarea, [role=link], [role=button], [onclick]')) return true;
      }
      return false;
    };
    const points = [];
    const words = doc.createTreeWalker(l, NodeFilter.SHOW_TEXT);
    for (let t = words.nextNode(); t && points.length < 12; t = words.nextNode()) {
      if (!t.nodeValue.trim()) continue;
      const range = doc.createRange();
      range.selectNodeContents(t);
      for (const r of range.getClientRects()) if (r.width > 2 && r.height > 2) points.push([r.x + Math.min(r.width / 2, 10), r.y + r.height / 2]);
    }
    const box = l.getBoundingClientRect();
    if (box.width && box.height) points.push([box.x + Math.min(box.width / 2, 10), box.y + box.height / 2]);
    let covered = false;
    for (const [x, y] of points) {
      const hit = at(x, y);
      if (!hit || !(hit === l || hit === el || l.contains(hit))) { covered = true; continue; }
      if (acts(hit)) continue;
      let px = x, py = y;
      for (let w = doc.defaultView; w && w !== window && w.frameElement; w = w.parent) {
        const f = w.frameElement.getBoundingClientRect();
        const cs = w.frameElement.ownerDocument.defaultView.getComputedStyle(w.frameElement);
        px += f.x + parseFloat(cs.borderLeftWidth || '0') + parseFloat(cs.paddingLeft || '0');
        py += f.y + parseFloat(cs.borderTopWidth || '0') + parseFloat(cs.paddingTop || '0');
      }
      return { x: px, y: py };
    }
    return points.length ? { blocked: covered ? 'covered' : 'link' } : null;
  })()`;
}

/**
 * Read back what a fill left in the field, and put it right if the page's
 * own scripts or the keyboard left something else: a stray key turned
 * "58 LPA" into "58tlf," on a real form. Set the way the page's framework
 * listens for, then read again; a field that still disagrees is reported.
 * A suggestion field may rewrite the text into its chosen option, so it is
 * left to the suggestion list.
 */
async function makeItHold(port: InputPort, ref: string | undefined, want: string): Promise<void> {
  const result = await port.evaluate<{ ok: boolean; now: string } | null>(`(() => {
    const el = window.__ba && window.__ba.refs.get(${JSON.stringify(ref)});
    if (!el || typeof el.value !== 'string' || el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete')) return null;
    if (el.readOnly || el.disabled) return null;
    const want = ${JSON.stringify(want)};
    const same = () => el.value.replace(/\\s+/g, ' ').trim() === want.replace(/\\s+/g, ' ').trim();
    if (same()) return { ok: true, now: el.value };
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, want);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: same(), now: el.value };
  })()`).catch(() => null);
  if (result && typeof result === 'object' && result.ok === false) {
    throw new ActionFailureError('NOT_ACTIONABLE', `the field holds ${JSON.stringify(fence(result.now.slice(0, 80)))}, not what was asked for`);
  }
}

/** Fields Chrome draws as pickers, which take no typed text, and the form each value is stored in. */
export const WHOLE_VALUE_FORMATS: Readonly<Record<string, string>> = {
  date: 'YYYY-MM-DD', month: 'YYYY-MM', week: 'YYYY-Www', time: 'HH:MM',
  'datetime-local': 'YYYY-MM-DDTHH:MM', color: '#rrggbb', range: 'a number',
};

/**
 * A date, month or time field ignores typed text: its value is set whole, the
 * way the page's own picker sets it, then read back. The browser drops a value
 * in the wrong form, so a mismatch is reported rather than called done.
 * Returns false for any other field.
 */
async function setWholeValue(port: InputPort, req: ActionRequest): Promise<boolean> {
  const want = req.value ?? '';
  const result = await port.evaluate<{ type: string; value: string } | null>(`(() => {
    const el = window.__ba && window.__ba.refs.get(${JSON.stringify(req.ref)});
    const kinds = ${JSON.stringify(Object.keys(WHOLE_VALUE_FORMATS))};
    if (!el || el.tagName !== 'INPUT' || !kinds.includes(el.type)) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, ${JSON.stringify(want)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { type: el.type, value: el.value };
  })()`).catch(() => null);
  if (!result || typeof result !== 'object' || !(result.type in WHOLE_VALUE_FORMATS)) return false;
  if (result.value !== want && !(result.type === 'range' && Number(result.value) === Number(want))) {
    throw new ActionFailureError('NOT_ACTIONABLE',
      `this is a ${result.type} field and did not take ${JSON.stringify(want)}: give it as ${WHOLE_VALUE_FORMATS[result.type]}`);
  }
  return true;
}

/**
 * A field that suggests as you type usually shows its list a moment later,
 * after a debounce or a round trip. Waiting for it means the snapshot that
 * follows holds the choices, not a field that only looks filled in.
 */
async function awaitSuggestions(port: InputPort, ref: string | undefined, maxMs = 1_500): Promise<void> {
  const probe = `(() => {
    const el = window.__ba && window.__ba.refs.get(${JSON.stringify(ref)});
    if (!el || (el.getAttribute('role') !== 'combobox' && !el.hasAttribute('aria-autocomplete'))) return 'no';
    if (el.getAttribute('aria-expanded') === 'true') return 'yes';
    const id = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    const list = id && document.getElementById(id);
    return list && list.checkVisibility() && list.querySelector('[role=option]') ? 'yes' : 'wait';
  })()`;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await port.evaluate<string>(probe).catch(() => 'no') !== 'wait') return;
    await new Promise((r) => setTimeout(r, 60));
  }
}

export async function clickAt(port: InputPort, x: number, y: number): Promise<void> {
  await port.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await port.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
  });
  await port.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0,
  });
}

/**
 * Turn the wheel over an element, or the middle of the window. A list that
 * scrolls inside its own pane (LinkedIn's results) only moves when the wheel
 * is over it; the top-left corner is usually the site's header.
 */
export async function scroll(port: InputPort, amount: number, ref?: string): Promise<void> {
  const at = await port.evaluate<{ x: number; y: number } | null>(`(() => {
    const el = ${JSON.stringify(ref ?? null)} && window.__ba && window.__ba.refs.get(${JSON.stringify(ref ?? '')});
    if (el && el.getBoundingClientRect) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) return { x: r.x + r.width / 2, y: Math.min(r.y + r.height / 2, innerHeight - 5) };
    }
    return { x: innerWidth / 2, y: innerHeight / 2 };
  })()`).catch(() => null);
  await port.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: at?.x ?? 10, y: at?.y ?? 10, deltaX: 0, deltaY: amount,
  });
}

export async function pressKey(port: InputPort, combo: string): Promise<void> {
  if (!knownKey(combo)) {
    throw new ActionFailureError('NOT_ACTIONABLE', `${JSON.stringify(combo)} is not a key: name one such as Enter, Tab, Escape, ArrowDown or Backspace, or a single character, with Shift+, Control+, Alt+ or Meta+ before it; nothing was pressed`);
  }
  for (const event of keyEvents(combo)) await port.send('Input.dispatchKeyEvent', event);
}

/**
 * Attach files to a file input.
 *
 * Deliberately does NOT go through Page's target resolution: a file input is usually
 * invisible — sites hide the real control behind a styled button — and the
 * visibility and geometry checks that make a click safe would reject almost
 * every real one. The ref lease is still enforced, and the element still
 * has to actually be `input[type=file]`.
 *
 * This layer takes filesystem paths because that is what CDP takes. WHICH
 * paths may be named is decided above it, in the loop, where only documents
 * the user imported can be chosen. Nothing here should be given a path that
 * came from a page or a model.
 */
export async function setFileInputFiles(port: InputPort, req: ActionRequest, files: string[], currentStateId: string | undefined): Promise<void> {
  if (!req.ref) throw new ActionFailureError('UNKNOWN_REF', 'upload requires a ref');
  if (!req.pageStateId) throw new ActionFailureError('STALE_STATE', 'upload requires a pageStateId');
  if (currentStateId !== req.pageStateId) {
    throw new ActionFailureError('STALE_STATE', 'ref is from a superseded observation');
  }

  const handle = await port.send('Runtime.evaluate', {
    expression: `(window.__ba && window.__ba.stateId === ${JSON.stringify(req.pageStateId)})
      ? window.__ba.refs.get(${JSON.stringify(req.ref)}) : null`,
    returnByValue: false,
  }) as { result: { objectId?: string; subtype?: string }; exceptionDetails?: { text: string } };
  const objectId = handle.result.objectId;
  if (!objectId) throw new ActionFailureError('UNKNOWN_REF', `${req.ref} is not in the current observation`);

  try {
    const kind = await port.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function () { return this.tagName + ":" + (this.type || "") + ":" + (this.isConnected ? "live" : "detached"); }',
      returnByValue: true,
    }) as { result: { value?: string } };
    const [tag, type, connected] = String(kind.result.value ?? '').split(':');
    if (connected !== 'live') throw new ActionFailureError('NOT_ACTIONABLE', 'element is detached');
    if (tag !== 'INPUT' || type !== 'file') {
      const is = tag === 'INPUT' ? `a ${type || 'text'} field` : `a ${tag.toLowerCase()} element`;
      throw new ActionFailureError('NOT_ACTIONABLE', `${req.ref} is ${is}, not a file input: attach to the file input or the button that opens it`);
    }
    await port.send('DOM.setFileInputFiles', { objectId, files });
  } finally {
    await port.send('Runtime.releaseObject', { objectId }).catch(() => {});
  }
}
