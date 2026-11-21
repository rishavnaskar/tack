/**
 * The form pass: what Fanfold holds goes into an application form in code,
 * before a model is asked anything.
 *
 * The fields of the form are resolved together, once, the way job_ask and
 * answer_questions resolve questions (answerer.ts). What Fanfold holds becomes
 * an ordinary action for each field; what only the user can answer is filed
 * for them; an optional field nobody can answer is left alone. The pass never
 * touches the page itself: Fanfold's own agent runs its actions through the
 * loop's policy, guard and act, a host's through govern.
 *
 * A field is only ever one of an application form's: inside a dialog or a
 * form that holds a button moving it on (Next, Review, Submit and the like).
 * A search box, a filter or a page with no such form receives nothing.
 */
import type { AgentAction } from './prompt.ts';
import type { ModelLike, RunTaskOptions } from './loop.ts';
import type { Observation, ObservedNode } from '../types.ts';
import type { Answer, Jobs } from '../jobs/jobs.ts';
import { normaliseQuestion, type Profile } from '../jobs/profile.ts';
import type { Asker, Questions, QuestionKind } from '../jobs/questions.ts';
import { answerQuestions, givenAnswer } from '../jobs/answerer.ts';
import { isSensitive, known, sameAnswer } from '../jobs/known.ts';
import { folded } from '../jobs/wording.ts';
import { personAsked, resumeLabel, type QuestionIntents } from '../jobs/intents.ts';
import type { CareerRecords } from '../jobs/career.ts';
import type { Memory } from '../memory/memory.ts';
import { secretAsked } from '../policy/secret-question.ts';
import { isCodeField } from '../connectors/mail-code.ts';
import { fence, unwrapUntrustedForDisplay } from '../policy/untrusted.ts';
import { seamAfter } from '../policy/structure.ts';
import { approvedFor, askerFor, fieldLabel, holdSensitive } from './record-actions.ts';

/** What the model reads after the pass, and each queued action's reason. */
export const COPY = {
  reason: 'Fanfold fills this from {from}',
  approved: 'what the user approved on Review',
  draft: 'a suggestion of Fanfold\'s ({why}), recorded as a draft',
  byFanfold: 'answered by Fanfold from {from}, not typed by the user',
  filled: 'Fanfold filled these fields from what it holds: {fields}.',
  waiting: 'Left blank, waiting for the user on Review: {fields}.',
  waitingOptional: 'Left blank for the user to answer on Review, though the form does not require them, so they do not stop a Submit: {fields}.',
  blank: 'Left blank, as the form does not require them and Fanfold holds no answer: {fields}.',
  declined: 'Left blank, as the user chose not to answer: {fields}.',
  leave: 'Do not type into the fields left blank or waiting, and change what Fanfold filled only when the field rejects it. A question Fanfold did not name here goes to answer_questions.',
  resume: 'the user\'s résumé, attached as a file',
  replaced: ', in place of {was}, which the form held and which says otherwise',
};

export interface FormPassDeps {
  jobs: Jobs;
  profile: Profile;
  memory?: Pick<Memory, 'listDocuments' | 'documentText' | 'searchDocuments'>;
  questions: Questions;
  intents?: QuestionIntents | null;
  careers?: CareerRecords | null;
  /** Fanfold's own model, for wordings nothing else knows; null for none. */
  model?: ModelLike | null;
  /** The job asking. */
  by: Asker;
  /** What the user approved on this application's Review card: their word for this form. */
  approved?: RunTaskOptions['approved'];
  /** Fanfold's own agent: its guard holds a question about the user that Fanfold holds no answer to. */
  strict?: boolean;
  /** Fields already passed, by their normalised question: each is passed once. */
  passed?: ReadonlySet<string>;
  /** The résumé to attach to the form's résumé field, for Fanfold's own agent; a host attaches files itself. */
  resume?: { id: string; title: string } | null;
  signal?: AbortSignal;
}

/** One field the pass fills: an ordinary action, and what the application keeps for it. */
export interface Fill {
  question: string;
  /** The field it is for, when several on the form ask the same. */
  key?: string;
  /** For a radio group, the option checked. */
  option?: string;
  value: string;
  /** Where the value came from, in words. */
  from: string;
  by: 'user' | 'fanfold' | 'draft' | 'approved';
  /** What the application keeps, by its real source; DRAFT for a suggestion. */
  given: Answer;
  /** Its ref is from the observation the pass read. */
  action: AgentAction;
}

export interface FormPass {
  actions: AgentAction[];
  filled: Fill[];
  /** Filed for the user, and left blank. */
  waiting: Array<{ question: string; id: number; draft: string | null; sensitive: boolean; required?: boolean }>;
  /** Optional, and nothing held: left blank, nothing filed. */
  blank: string[];
  /** The user chose not to answer: left blank. */
  declined: string[];
  /** Every field the pass looked at, by normalised question. */
  seen: string[];
  asked: { ids: number[]; fresh: number };
}

/** One field of an application form, as the pass reads it. */
interface Field {
  question: string;
  key: string;
  kind: QuestionKind;
  choices: string[];
  required: boolean;
  /** What it holds now, '' when blank. */
  current: string;
  node: ObservedNode;
  act: 'fill' | 'select' | 'check';
  /** A radio group's options. */
  radios?: Array<{ node: ObservedNode; label: string; checked: boolean }>;
}

const CONTAINERS = new Set(['dialog', 'alertdialog', 'form']);
const MOVES_ON = /\b(next|continue|review|submit|apply|send|save)\b/i;
const FILTERS = /\bfilters?\b/i;
const SEARCH = /\bsearch\b/i;
const FIELD_ROLES = new Set(['textbox', 'spinbutton', 'combobox', 'listbox']);
const NOT_TYPED = new Set(['password', 'hidden', 'file', 'search', 'checkbox', 'radio']);
const PROMPT = /^(?:please\s+)?(?:select|choose|pick)\b|^-+$/i;

const words = (n: ObservedNode): string => [n.name, n.text].filter(Boolean).map((t) => unwrapUntrustedForDisplay(t!)).join(' ').trim();
const keyOf = (question: string): string => normaliseQuestion(question);

/**
 * What a control takes, as browser_fill decides it for a field given no
 * action: a native or searchable dropdown has its option chosen, a radio is
 * checked, a checkbox ticked or unticked, anything else typed.
 */
export function actionFor(node: Pick<ObservedNode, 'role' | 'evidence'> | undefined, value?: string): 'fill' | 'select' | 'check' | 'uncheck' {
  const control = node?.evidence?.control;
  if (control === 'select') return 'select';
  if (control === 'checkbox') return /^(false|no|off|unchecked|0|)$/i.test(value?.trim() ?? 'true') ? 'uncheck' : 'check';
  if ((node?.role === 'combobox' || node?.role === 'listbox') && control !== 'radio') return 'select';
  if (control === 'radio') return 'check';
  return 'fill';
}

const movesOn = (n: ObservedNode): boolean => (n.role === 'button' || n.evidence?.isSubmit === true) && MOVES_ON.test(words(n));
const searches = (n: ObservedNode): boolean => n.role === 'searchbox' || (FIELD_ROLES.has(n.role) && SEARCH.test(fieldLabel(n.name)));

/**
 * Where an application form sits on the page: each dialog or form whose
 * subtree (by depth, never across a seam) holds a button that moves it on,
 * and is neither a search nor a set of filters.
 */
function formScopes(observation: Observation): Array<[number, number]> {
  const { nodes } = observation;
  const scopes: Array<[number, number]> = [];
  for (let i = 0; i < nodes.length; i++) {
    const box = nodes[i];
    if (!CONTAINERS.has(box.role) || FILTERS.test(words(box))) continue;
    const limit = seamAfter(observation, i);
    let end = i + 1;
    while (end < limit && nodes[end].depth > box.depth) end++;
    const inside = nodes.slice(i + 1, end);
    if (inside.some(movesOn) && !inside.some(searches)) scopes.push([i + 1, end]);
  }
  return scopes;
}

/**
 * The same, for a form the page leaves unnamed and so unshown: its controls
 * are known by the form they belong to.
 */
function formsByIndex(observation: Observation): Set<number> {
  const forms = new Map<number, ObservedNode[]>();
  for (const n of observation.nodes) {
    const index = n.evidence?.inForm ? n.evidence.formIndex : undefined;
    if (typeof index === 'number') forms.set(index, [...(forms.get(index) ?? []), n]);
  }
  const ok = new Set<number>();
  for (const [index, controls] of forms) {
    const named = controls.find((n) => n.evidence?.formLabel)?.evidence?.formLabel ?? '';
    if (controls.some(movesOn) && !controls.some(searches) && !SEARCH.test(named) && !FILTERS.test(named)) ok.add(index);
  }
  return ok;
}

/** Whether the node at an index is inside one of the page's application forms; null when it has none. */
function insideForms(observation: Observation): ((i: number) => boolean) | null {
  const scopes = formScopes(observation);
  const forms = formsByIndex(observation);
  if (!scopes.length && !forms.size) return null;
  return (i: number): boolean => {
    const index = observation.nodes[i].evidence?.formIndex;
    return scopes.some(([a, b]) => i >= a && i < b) || (observation.nodes[i].evidence?.inForm === true && typeof index === 'number' && forms.has(index));
  };
}

/** The key a résumé field is passed under: it is one per form, whatever its label says. */
const RESUME_KEY = '#resume';

/** Where the résumé goes: an application form's file field named for one ("Résumé", "Resume/CV"), with no file in it yet. */
export function resumeField(observation: Observation): ObservedNode | null {
  const inside = insideForms(observation);
  if (!inside) return null;
  const at = observation.nodes.findIndex((n, i) => !!n.ref && !n.state.disabled && n.evidence?.control === 'file' && inside(i)
    && resumeLabel(`${fieldLabel(n.name)} ${fieldLabel(n.evidence?.group)}`));
  const node = at >= 0 ? observation.nodes[at] : null;
  return node && !fieldLabel(node.value) ? node : null;
}

/** The fields of the application forms on this page, each once, blank or not. */
function fieldsOf(observation: Observation): Field[] {
  const inside = insideForms(observation);
  if (!inside) return [];
  const fields: Field[] = [];
  const keys = new Set<string>();
  const groups = new Map<string, Field>();
  for (const [i, n] of observation.nodes.entries()) {
    if (!n.ref || n.state.disabled || !inside(i)) continue;
    if (n.role === 'radio') {
      const question = fieldLabel(n.evidence?.group);
      const option = fieldLabel(n.name);
      if (!question || !option || SEARCH.test(question)) continue;
      let group = groups.get(question);
      if (!group) {
        if (keys.has(keyOf(question))) continue;
        group = { question, key: keyOf(question), kind: 'choice', choices: [], required: false, current: '', node: n, act: 'check', radios: [] };
        groups.set(question, group);
        keys.add(group.key);
        fields.push(group);
      }
      group.radios!.push({ node: n, label: option, checked: n.state.checked === true });
      if (n.state.required || n.evidence?.groupRequired) group.required = true;
      continue;
    }
    if (!FIELD_ROLES.has(n.role)) continue;
    const type = String(n.evidence?.inputType ?? '').toLowerCase();
    const control = n.evidence?.control;
    if (NOT_TYPED.has(type) || control === 'file' || control === 'checkbox' || control === 'radio' || isCodeField(n)) continue;
    const question = fieldLabel(n.name);
    if (!question || SEARCH.test(question) || !keyOf(question)) continue;
    // Fields asking alike are told apart by their order on the form, and each is filled.
    let key = keyOf(question);
    for (let nth = 2; keys.has(key); nth++) key = `${keyOf(question)}#${nth}`;
    keys.add(key);
    const choices = (n.options ?? []).map((o) => fieldLabel(o)).filter((o) => o && !PROMPT.test(o)).slice(0, 20);
    const kind: QuestionKind = choices.length ? (yesNo(choices) ? 'yes_no' : 'choice') : n.role === 'spinbutton' || type === 'number' ? 'number' : 'text';
    const current = fieldLabel(n.value);
    const act = actionFor(n);
    fields.push({ question, key, kind, choices, required: n.state.required === true, current: PROMPT.test(current) ? '' : current, node: n, act: act === 'uncheck' ? 'check' : act });
  }
  for (const group of groups.values()) {
    group.choices = group.radios!.map((r) => r.label);
    group.kind = yesNo(group.choices) ? 'yes_no' : 'choice';
    group.current = group.radios!.find((r) => r.checked)?.label ?? '';
  }
  return fields.filter((f) => f.key);
}

const yesNo = (choices: string[]): boolean => choices.length === 2 && choices.map((c) => folded(c)).sort().join('|') === 'no|yes';

/**
 * The fields of this page's application forms the pass would act on: blank,
 * or holding a value other than the one the user approved for it.
 */
export function formFields(observation: Observation, approved?: RunTaskOptions['approved']): Array<{ question: string; key: string; required: boolean }> {
  return fieldsOf(observation)
    .filter((f) => {
      if (!f.current) return true;
      const said = approvedFor(approved, f.question);
      return said !== null && !sameAnswer(said, f.current);
    })
    .map(({ question, key, required }) => ({ question, key, required }));
}

/**
 * What a question on this page offers, when it is a dropdown or a group of
 * buttons: the answer must be one of its options, so it is asked with them.
 * Matched by its words, accents and case aside. Null for a field that takes
 * any text, or a question not on this page.
 */
export function pageChoices(observation: Observation, question: string): { kind: QuestionKind; choices: string[] } | null {
  const key = keyOf(question);
  if (!key) return null;
  const field = fieldsOf(observation).find((f) => keyOf(f.question) === key && f.choices.length);
  return field ? { kind: field.kind, choices: field.choices } : null;
}

/** The control a fill is aimed at, found again on a page that may have changed since: by its question and place among those asking alike, and a radio by its option. */
export function locate(observation: Observation, fill: Pick<Fill, 'question' | 'option' | 'key'>): ObservedNode | null {
  if (fill.key === RESUME_KEY) return resumeField(observation);
  const field = fieldsOf(observation).find((f) => f.key === (fill.key ?? keyOf(fill.question)));
  if (!field) return null;
  if (field.radios) return field.radios.find((r) => r.label === fill.option)?.node ?? null;
  return field.node;
}

/** The option a value names: the same words, else the one option saying the same. */
function pick(choices: string[], value: string): string | null {
  const exact = choices.find((c) => folded(c) === folded(value));
  if (exact) return exact;
  const alike = choices.filter((c) => sameAnswer(c, value));
  return alike.length === 1 ? alike[0] : null;
}

/** The action that puts this value into the field, or null when the field offers nothing that says it. */
function aim(field: Field, value: string, reason: string): { action: AgentAction; option?: string } | null {
  if (field.radios) {
    const option = pick(field.choices, value);
    const node = option ? field.radios.find((r) => r.label === option)?.node : undefined;
    return node ? { action: { kind: 'check', ref: node.ref!, reason }, option: option! } : null;
  }
  const chosen = field.choices.length ? pick(field.choices, value) : value;
  return chosen ? { action: { kind: field.act, ref: field.node.ref!, value: chosen, reason } } : null;
}

/**
 * Resolve an application form's fields at once and say what to do with each.
 *
 * - approved for this form → that value, whatever else Fanfold holds;
 * - an answer → that value;
 * - a suggestion, not sensitive → that value, recorded as a draft;
 * - a suggestion for a sensitive question → left blank and filed with it, unless
 *   it is what the user said in another form ("70" for "70 LPA");
 * - nothing held → filed when the form requires it, else left blank.
 *
 * A value is only queued when the guard the action meets would let it in.
 */
export async function formPass(observation: Observation, deps: FormPassDeps): Promise<FormPass> {
  const { jobs, profile, questions, intents, careers, by } = deps;
  const memory = deps.memory ?? ({ listDocuments: () => [], documentText: () => null, searchDocuments: () => [] } as unknown as NonNullable<FormPassDeps['memory']>);
  const out: FormPass = { actions: [], filled: [], waiting: [], blank: [], declined: [], seen: [], asked: { ids: [], fresh: 0 } };
  const fields = fieldsOf(observation).filter((f) => !deps.passed?.has(f.key));
  const said = (f: Field): string | null => approvedFor(deps.approved, f.question);
  // The user's résumé goes in the form's résumé field, labelled however the form labels it.
  const cv = deps.resume && !deps.passed?.has(RESUME_KEY) ? resumeField(observation) : null;
  if (cv?.ref && deps.resume) {
    const question = fieldLabel(cv.name) || 'Résumé';
    out.seen.push(RESUME_KEY);
    out.filled.push({
      question, key: RESUME_KEY, value: deps.resume.title, from: COPY.resume, by: 'fanfold',
      given: { question, answer: deps.resume.title, source: 'FANFOLD' },
      action: { kind: 'upload', ref: cv.ref, value: deps.resume.id, reason: COPY.reason.replace('{from}', COPY.resume) },
    });
  }
  // A sensitive answer the form already holds that says otherwise than the user did is put right, and said.
  const contradicts = new Map<string, string>();
  for (const f of fields) {
    if (!f.current || said(f) !== null || !isSensitive(f.question, f.kind, by, { profile, intents })) continue;
    const k = await known({ question: f.question, kind: f.kind, ...(f.choices.length ? { choices: f.choices } : {}) }, by, { profile, jobs, memory, intents, careers }).catch(() => null);
    if (k?.outcome === 'answer' && k.by === 'user' && !sameAnswer(k.answer, f.current)) contradicts.set(f.key, f.current);
    else out.seen.push(f.key);
  }
  const open = fields.filter((f) => {
    const approved = said(f);
    return f.current ? (approved !== null ? !sameAnswer(approved, f.current) : contradicts.has(f.key)) : true;
  });
  if (!open.length) {
    out.actions = out.filled.map((f) => f.action);
    return out;
  }

  // What the loop's guard would do with it, asked without filing anything: a value it would refuse is not queued.
  const dry = { questions: { ask: () => ({ question: { id: 0, status: 'open' }, fresh: false }) } as unknown as Questions, intents: intents ?? undefined, careers: careers ?? undefined, model: null };
  const lets = async (action: AgentAction, node: ObservedNode): Promise<boolean> =>
    !(await holdSensitive(action, node, { jobs, profile, memory: memory as Memory, answering: dry, pageUrl: observation.url, approved: deps.approved, strict: deps.strict }).catch(() => null));
  const file = (f: Field, draft: { value: string; why: string } | null, why: string | null, intentKey: string | null, sensitive: boolean): void => {
    const asked = { question: f.question, kind: f.kind, ...(f.choices.length ? { choices: f.choices } : {}) };
    const filed = questions.ask(asked, by, { draft, why, intentKey });
    if (filed.question.status === 'declined') {
      out.declined.push(f.question);
      return;
    }
    if (filed.fresh) out.asked.fresh++;
    out.asked.ids.push(filed.question.id);
    out.waiting.push({ question: f.question, id: filed.question.id, draft: draft?.value ?? null, sensitive, required: f.required });
  };
  const queue = async (f: Field, value: string, from: string, kind: Fill['by'], given: Answer): Promise<boolean> => {
    const aimed = aim(f, value, COPY.reason.replace('{from}', from));
    if (!aimed) return false;
    if (!await lets(aimed.action, aimed.option ? f.radios!.find((r) => r.label === aimed.option)!.node : f.node)) return false;
    const typed = aimed.option ?? aimed.action.value!;
    out.filled.push({ question: f.question, key: f.key, ...(aimed.option ? { option: aimed.option } : {}), value: typed, from, by: kind, given: { ...given, answer: typed }, action: aimed.action });
    return true;
  };

  const unsaid = open.filter((f) => said(f) === null && !secretAsked(f.question));
  const run = unsaid.length
    ? await answerQuestions({ profile, jobs, memory, intents, careers, model: deps.model ?? null, signal: deps.signal },
      unsaid.map((f) => ({ question: f.question, kind: f.kind, choices: f.choices })), by, { essays: false })
    : { results: [] };

  for (const f of open) {
    out.seen.push(f.key);
    const approved = said(f);
    if (approved !== null) {
      await queue(f, approved, COPY.approved, 'approved', { question: f.question, answer: approved, source: 'BANK' });
      continue;
    }
    // A password, a card or an ID number: the user types it into the form themselves.
    if (secretAsked(f.question)) continue;
    const r = run.results[unsaid.indexOf(f)];
    const k = r.known;
    const sensitive = isSensitive(f.question, f.kind, by, { profile, intents });
    if (k.outcome === 'ask') {
      if (f.required) file(f, null, k.why ?? null, r.intentKey, sensitive);
      else out.blank.push(f.question);
      continue;
    }
    // Where only a held answer may go (an address, a phone, a date, a yes or no about the person), a guess never does,
    // and an address is never the city in the profile: it is the user's own answer or nothing.
    // A sensitive question has its own rule below: only the user's word.
    const heldOnly = sensitive ? null : personAsked(f.question, f.kind, { choices: f.choices, inputType: f.node.evidence?.inputType });
    if (heldOnly && (k.outcome === 'draft' || (k.outcome === 'answer' && heldOnly === 'address' && k.answerId === undefined))) {
      const draft = k.outcome === 'draft' ? { value: k.draft, why: k.why } : { value: k.answer, why: k.statement ?? k.from };
      if (f.required) file(f, draft, null, r.intentKey, sensitive);
      else out.blank.push(f.question);
      continue;
    }
    if (k.outcome === 'answer') {
      const was = contradicts.get(f.key);
      const from = (k.by === 'fanfold' ? COPY.byFanfold.replace('{from}', k.from) : k.from) + (was ? COPY.replaced.replace('{was}', JSON.stringify(was)) : '');
      if (await queue(f, k.answer, from, k.by, givenAnswer(f.question, k))) {
        if (k.answerId) profile.useAnswer(k.answerId);
        continue;
      }
      if (f.required || sensitive) file(f, { value: k.answer, why: k.statement ?? k.from }, null, r.intentKey, sensitive);
      else out.blank.push(f.question);
      continue;
    }
    // A suggestion for a sensitive question goes in only when it is what the user said, in another form.
    if (sensitive) {
      const plain = await known({ question: f.question, kind: 'text' }, by, { profile, jobs, memory, intents, careers }).catch(() => null);
      const theirs = plain?.outcome === 'answer' && plain.by === 'user' && sameAnswer(plain.answer, k.draft) ? plain : null;
      if (theirs && await queue(f, k.draft, theirs.from, 'user', givenAnswer(f.question, theirs))) continue;
      file(f, { value: k.draft, why: k.why }, null, r.intentKey, true);
      continue;
    }
    if (await queue(f, k.draft, COPY.draft.replace('{why}', k.why), 'draft', { question: f.question, answer: k.draft, source: 'DRAFT' })) continue;
    if (f.required) file(f, { value: k.draft, why: k.why }, null, r.intentKey, false);
    else out.blank.push(f.question);
  }
  out.actions = out.filled.map((f) => f.action);
  return out;
}

/** What the model is told once the pass's actions have run: one line, the page's questions fenced as data. */
function passSummary(pass: Pick<FormPass, 'waiting' | 'blank' | 'declined'>, landed: Fill[]): string | null {
  const q = (question: string): string => JSON.stringify(fence(question));
  const parts: string[] = [];
  if (landed.length) parts.push(COPY.filled.replace('{fields}', landed.map((f) => `${q(f.question)} → ${q(f.value)} (${fence(f.from)})`).join('; ')));
  // A question filed for the user that the form does not require is no reason to hold the Submit.
  const needed = pass.waiting.filter((w) => w.required !== false);
  const optional = pass.waiting.filter((w) => w.required === false);
  if (needed.length) parts.push(COPY.waiting.replace('{fields}', needed.map((w) => q(w.question)).join(', ')));
  if (optional.length) parts.push(COPY.waitingOptional.replace('{fields}', optional.map((w) => q(w.question)).join(', ')));
  if (pass.blank.length) parts.push(COPY.blank.replace('{fields}', pass.blank.map(q).join(', ')));
  if (pass.declined.length) parts.push(COPY.declined.replace('{fields}', pass.declined.map(q).join(', ')));
  if (!parts.length) return null;
  return [...parts, COPY.leave].join(' ');
}

/**
 * The pass as Fanfold's own agent runs it: each field passed once a run,
 * its actions taken one step at a time, at most `cap` of them a run. What it
 * did is told to the model once the last of a pass's actions has run.
 */
export class FormQueue {
  readonly #deps: Omit<FormPassDeps, 'by' | 'passed'>;
  readonly #cap: number;
  readonly #passed = new Set<string>();
  #queue: Fill[] = [];
  #pass: FormPass | null = null;
  #landed: Fill[] = [];
  #taken = 0;

  constructor(deps: Omit<FormPassDeps, 'by' | 'passed'>, cap = 40) {
    this.#deps = deps;
    this.#cap = cap;
  }

  /** Something of this page's form the pass has not looked at: a field to fill, the résumé's, or a sensitive answer the form already holds. */
  #unpassed(observation: Observation): boolean {
    if (formFields(observation, this.#deps.approved).some((f) => !this.#passed.has(f.key))) return true;
    if (this.#deps.resume && !this.#passed.has(RESUME_KEY) && resumeField(observation)) return true;
    const { profile, intents } = this.#deps;
    return fieldsOf(observation).some((f) => f.current && !this.#passed.has(f.key) && isSensitive(f.question, f.kind, null, { profile, intents }));
  }

  /** Queued steps taken so far this run. */
  get taken(): number {
    return this.#taken;
  }

  /** This queued fill went into the page. */
  landed(fill: Fill): void {
    this.#landed.push(fill);
  }

  /**
   * The next queued action, found again on this page, or none. A pass runs
   * first when the page shows form fields not yet passed; `note` is what the
   * model is told about a pass that has finished, `asked` what it filed.
   */
  async next(observation: Observation): Promise<{ fill: Fill | null; note: string | null; asked: { ids: number[]; fresh: number; company: string; title: string; questions: string[] } | null }> {
    const notes: string[] = [];
    let asked: { ids: number[]; fresh: number; company: string; title: string; questions: string[] } | null = null;
    const settle = (): void => {
      if (!this.#pass || this.#queue.length) return;
      const note = passSummary(this.#pass, this.#landed);
      if (note) notes.push(note);
      this.#pass = null;
      this.#landed = [];
    };
    settle();
    if (!this.#queue.length && this.#taken < this.#cap && this.#unpassed(observation)) {
      const by = askerFor(this.#deps.jobs, observation.url);
      const pass = await formPass(observation, { ...this.#deps, by, passed: this.#passed });
      for (const key of pass.seen) this.#passed.add(key);
      if (pass.asked.ids.length) asked = { ...pass.asked, company: by.company, title: by.title, questions: pass.waiting.map((w) => w.question) };
      this.#pass = pass;
      this.#queue = [...pass.filled];
    }
    let fill: Fill | null = null;
    while (!fill && this.#queue.length && this.#taken < this.#cap) {
      const next = this.#queue.shift()!;
      const node = locate(observation, next);
      if (node?.ref) fill = { ...next, action: { ...next.action, ref: node.ref } };
    }
    // The last fill is told about once it has run, on the next step; a pass with nothing left to run is told about now.
    if (fill) this.#taken++;
    else {
      this.#queue = [];
      settle();
    }
    return { fill, note: notes.length ? notes.join('\n') : null, asked };
  }
}
