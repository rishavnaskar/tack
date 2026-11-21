/**
 * Approval requests and resumption.
 *
 * When the policy engine blocks an action, the run stops and a request is
 * recorded. A person then approves, edits, or rejects it, and the run resumes.
 *
 * The subtle part is resumption. Time passes between the request and the
 * answer — minutes, or overnight — and the page has moved on. The refs from
 * the observation that produced the request are long dead. So approval is
 * recorded against WHAT WAS APPROVED, not against a ref:
 *
 *   - the element's role and accessible name,
 *   - the URL it was on,
 *   - the exact content, if the action carries content.
 *
 * On resume, the page is re-observed and the approved target is located again
 * by those properties. If it cannot be found, or the content in the field no
 * longer matches what the user approved, the action is NOT performed and a
 * fresh approval is requested. Approving "Send" on one message must never
 * authorise sending a different one.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentAction } from './prompt.ts';
import type { BrowserRuntime } from '../observe/runtime.ts';
import type { ActionEvidence, ActionRequest, ActionResult, Observation, ObservedNode, PageStateId, Ref, Sensitivity } from '../types.ts';
import { fence, unwrapUntrustedForDisplay } from '../policy/untrusted.ts';
import { humanOnly } from '../policy/human-only.ts';
import { unaccented } from '../policy/engine.ts';
import type { SitePolicies } from '../jobs/site-policies.ts';
import type { Jobs } from '../jobs/jobs.ts';
import { deriveRecipient, whenSaid } from '../policy/recipient.ts';
import { seamAfter, seamBefore } from '../policy/structure.ts';
import { Memory } from '../memory/memory.ts';
import { NO_EFFECT_FAILURES } from './effect-rules.ts';
import { isNoAnswer, isTransportLoss } from '../cdp/loss.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  step_idx      INTEGER NOT NULL,
  status        TEXT NOT NULL,          -- pending | approved | performing | rejected | expired | consumed
  sensitivity   TEXT NOT NULL,
  why           TEXT NOT NULL,
  url           TEXT NOT NULL,
  action_kind   TEXT NOT NULL,
  target_role   TEXT,
  target_name   TEXT,
  -- What the control structurally IS. Role and name alone could not tell a
  -- hidden file input from the heading above it, so an approved upload
  -- re-resolved onto the wrong element.
  target_input_type TEXT,
  content       TEXT,                   -- what will be sent, exactly
  edited_content TEXT,                  -- what the user changed it to
  requested_at  TEXT NOT NULL,
  answered_at   TEXT,
  answered_note TEXT,
  form          TEXT,                   -- what the form held when a submit was asked for
  asked_by      TEXT,                   -- the outside agent that asked, if one did
  prior_contact_at TEXT,                -- the earlier contact with this person the card told its reader about
  page_title    TEXT,                   -- the page it was asked on, so the card can say which job
  outcome       TEXT,                   -- sent | refused | unknown | not_done: what came of carrying it out
  outcome_detail TEXT,
  attempts      INTEGER                 -- how many times it was pressed
);
CREATE INDEX IF NOT EXISTS approvals_pending ON approvals(status, requested_at);
`;

export type ApprovalStatus = 'pending' | 'approved' | 'performing' | 'rejected' | 'expired' | 'consumed';

/**
 * What came of carrying an approval out. `refused` means the page turned the
 * submit away and nothing reached anyone; `unknown` means it may have gone.
 */
export type ApprovalOutcome = 'sent' | 'refused' | 'unknown' | 'not_done';

/** A page refusal leaves the approval standing for the same answers, this many presses in all. */
const MAX_ATTEMPTS = 3;
const STANDING_MS = 30 * 60_000;

export interface ApprovalRequest {
  id: string;
  runId: string;
  stepIdx: number;
  status: ApprovalStatus;
  sensitivity: Sensitivity;
  why: string;
  url: string;
  actionKind: string;
  targetRole: string | null;
  targetName: string | null;
  targetInputType: string | null;
  content: string | null;
  editedContent: string | null;
  /** What each field of the form held, read from the page, when the action submits it. */
  form: FormField[] | null;
  /** The outside agent that asked for this, when it was not Fanfold's own. */
  askedBy: string | null;
  /** The contact mark the card was raised under, when it told its reader of an earlier contact. Approving it then means sending again. */
  priorContactAt: string | null;
  /** The title of the page it was asked on, which names the job. Untrusted, for display. */
  pageTitle: string | null;
  requestedAt: string;
  answeredAt: string | null;
  outcome: ApprovalOutcome | null;
  outcomeDetail: string | null;
  /** What was noted when it was approved: where, or that the person's standing yes covered it. */
  answeredNote?: string | null;
}

export interface FormField {
  label: string;
  value: string;
  /** The form marks this one required: left blank, the submit will likely be turned away. */
  required?: boolean;
}

export class Approvals {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#db.exec(SCHEMA);
    const columns = this.#db.prepare("PRAGMA table_info('approvals')").all() as Array<{ name: string }>;
    for (const added of ['target_input_type', 'form', 'asked_by', 'prior_contact_at', 'page_title', 'outcome', 'outcome_detail', 'attempts']) {
      if (columns.length && !columns.some((c) => c.name === added)) {
        this.#db.exec(`ALTER TABLE approvals ADD COLUMN ${added} ${added === 'attempts' ? 'INTEGER' : 'TEXT'}`);
      }
    }
  }

  /**
   * Record a blocked action for review.
   *
   * `content` is what would actually be sent — read from the page, not from
   * the model's description of it. A review card showing something other than
   * the bytes that will leave the machine is worse than no review at all.
   *
   * `live` is the page read again as the card is made. The action was judged
   * on `observation`, but a host that chained actions without looking holds an
   * older picture, and the card must show what the form holds now.
   *
   * With `standing`, an approval the page turned away is handed back for the
   * same press on the same answers: the person approved this application,
   * and nothing reached anyone.
   */
  request(args: {
    runId: string; stepIdx: number; action: AgentAction; observation: Observation;
    sensitivity: Sensitivity; why: string; priorContactAt?: string | null;
    live?: Observation | null; standing?: boolean;
  }): ApprovalRequest {
    const ref = args.action.ref?.replace(/^@/, '');
    const node = ref ? args.observation.nodes.find((n) => n.ref === ref) : undefined;
    const page = args.live && args.live.url === args.observation.url ? args.live : args.observation;
    const content = args.action.value ?? composerContent(page) ?? null;
    // A key press names no control: it goes to whatever has focus.
    const submitting = (ref ? page.nodes.find((n) => n.ref === ref) : undefined) ?? (page === args.observation ? node : undefined)
      ?? (args.action.kind === 'press' ? page.nodes.find((n) => n.evidence?.focused) : undefined);
    const form = args.action.kind === 'click' || args.action.kind === 'press'
      ? formContents(page, submitting, args.why) : null;

    const sameAsk = `run_id = ? AND url = ? AND action_kind = ?
      AND COALESCE(target_role, '') = ? AND COALESCE(target_name, '') = ? AND COALESCE(content, '') = ?`;
    const key = [args.runId, args.observation.url, args.action.kind, node?.role ?? '',
      node?.name ? unwrapUntrustedForDisplay(node.name) : '', content ?? ''];
    // Asking twice for the same thing while the first is still waiting is one
    // question for the person, not two cards that could both be approved.
    const same = this.#db.prepare(`SELECT * FROM approvals WHERE status = 'pending' AND ${sameAsk} LIMIT 1`)
      .get(...key) as Record<string, unknown> | undefined;
    // A waiting card that no longer shows what the form holds is withdrawn for one that does.
    if (same && JSON.stringify(parseForm(same.form)) === JSON.stringify(form)) return toRequest(same);
    if (same) this.#db.prepare("UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'pending'").run(same.id as string);
    if (args.standing) {
      const standing = this.#db.prepare(`SELECT * FROM approvals WHERE status = 'approved' AND outcome = 'refused'
        AND COALESCE(attempts, 0) < ? AND answered_at > ? AND ${sameAsk} ORDER BY answered_at DESC LIMIT 1`)
        .get(MAX_ATTEMPTS, new Date(Date.now() - STANDING_MS).toISOString(), ...key) as Record<string, unknown> | undefined;
      if (standing && JSON.stringify(parseForm(standing.form)) === JSON.stringify(form)) return toRequest(standing);
    }
    const id = randomUUID();

    this.#db.prepare(`
      INSERT INTO approvals (id, run_id, step_idx, status, sensitivity, why, url,
                             action_kind, target_role, target_name, target_input_type,
                             content, form, prior_contact_at, page_title, requested_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, args.runId, args.stepIdx, 'pending', args.sensitivity, args.why, args.observation.url,
      args.action.kind,
      node?.role ?? null,
      node?.name ? unwrapUntrustedForDisplay(node.name) : null,
      node?.evidence?.inputType ?? null,
      content,
      form ? JSON.stringify(form) : null,
      args.priorContactAt ?? null,
      unwrapUntrustedForDisplay(args.observation.title).slice(0, 200) || null,
      new Date().toISOString(),
    );
    return this.get(id)!;
  }

  /** Say more on a card still waiting. */
  amend(id: string, why: string): void {
    this.#db.prepare("UPDATE approvals SET why = ? WHERE id = ? AND status = 'pending'").run(why, id);
  }

  /** Note which outside agent asked, so the person approving knows it was not Fanfold's own. */
  attribute(id: string, askedBy: string): void {
    this.#db.prepare('UPDATE approvals SET asked_by = ? WHERE id = ?').run(askedBy.slice(0, 80), id);
  }

  get(id: string): ApprovalRequest | null {
    const row = this.#db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toRequest(row) : null;
  }

  /** The approvals one run asked for, newest first. */
  forRun(runId: string, limit = 20): ApprovalRequest[] {
    return (this.#db.prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY requested_at DESC LIMIT ?')
      .all(runId, limit) as Array<Record<string, unknown>>).map(toRequest);
  }

  pending(): ApprovalRequest[] {
    const rows = this.#db.prepare(
      "SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at",
    ).all() as Array<Record<string, unknown>>;
    return rows.map(toRequest);
  }

  /**
   * Approve, optionally replacing the content. True when this call made the
   * approval; false when it was already answered.
   *
   * Whatever text comes back is what gets sent, verbatim. An edited draft that
   * is then "improved" on the way out is not the thing the person approved.
   */
  approve(id: string, editedContent?: string, note?: string): boolean {
    const res = this.#db.prepare(
      "UPDATE approvals SET status = 'approved', answered_at = ?, edited_content = ?, answered_note = ? WHERE id = ? AND status = 'pending'",
    ).run(new Date().toISOString(), editedContent ?? null, note ?? null, id);
    return Number(res.changes) === 1;
  }

  /**
   * Take an approved request to carry out. One caller gets it: the person
   * clicking Approve in two places, or in Review and in the host's dialog,
   * must not send the application twice.
   */
  claim(id: string): boolean {
    const res = this.#db.prepare("UPDATE approvals SET status = 'performing' WHERE id = ? AND status = 'approved'").run(id);
    return Number(res.changes) === 1;
  }

  /** Hand back a claim that was not carried out, so it can be tried again. */
  release(id: string, detail?: string): void {
    this.#db.prepare(`UPDATE approvals SET status = 'approved', outcome = COALESCE(?, outcome), outcome_detail = COALESCE(?, outcome_detail)
      WHERE id = ? AND status = 'performing'`).run(detail ? 'not_done' : null, detail?.slice(0, 600) ?? null, id);
  }

  /**
   * Say what came of a claim. Sent, or possibly sent, spends the approval. A
   * press the page turned away reached nobody: the approval stands for the
   * same answers, a few presses at most.
   */
  settle(id: string, outcome: Exclude<ApprovalOutcome, 'not_done'>, detail: string): void {
    this.#db.prepare(`UPDATE approvals SET status = ?, outcome = ?, outcome_detail = ?, attempts = COALESCE(attempts, 0) + 1
      WHERE id = ? AND status = 'performing'`).run(outcome === 'refused' ? 'approved' : 'consumed', outcome, detail.slice(0, 600), id);
  }

  /**
   * Claims a closed Fanfold left in the middle of being carried out. Whether
   * the press landed cannot be known now, so they are spent, and the agent
   * waiting on one is told to check the page.
   */
  resolveStranded(bootedAt: Date): number {
    const res = this.#db.prepare(`UPDATE approvals SET status = 'consumed', outcome = 'unknown', outcome_detail = ?
      WHERE status = 'performing' AND COALESCE(answered_at, requested_at) < ?`)
      .run('Fanfold stopped while carrying it out, so it may have been sent; check the page before pressing it again', bootedAt.toISOString());
    return Number(res.changes);
  }

  /**
   * The page it was asked on is gone, so it can never be carried out: it ends
   * here, not done. A press already on its way is left to say what came of it.
   */
  end(id: string, detail: string): boolean {
    const res = this.#db.prepare(`UPDATE approvals SET status = 'expired', outcome = 'not_done', outcome_detail = ?
      WHERE id = ? AND status IN ('pending', 'approved', 'performing')`).run(detail.slice(0, 600), id);
    return Number(res.changes) === 1;
  }

  /** The same for every request of a run that is waiting or approved. Returns the ids it ended. */
  endFor(runId: string, detail: string): string[] {
    const ids = (this.#db.prepare("SELECT id FROM approvals WHERE run_id = ? AND status IN ('pending', 'approved')")
      .all(runId) as Array<{ id: string }>).map((r) => r.id);
    return ids.filter((id) => this.end(id, detail));
  }

  /** True when this call rejected it; false when it was already answered. */
  reject(id: string, note?: string): boolean {
    const res = this.#db.prepare(
      "UPDATE approvals SET status = 'rejected', answered_at = ?, answered_note = ? WHERE id = ? AND status = 'pending'",
    ).run(new Date().toISOString(), note ?? null, id);
    return Number(res.changes) === 1;
  }

  /** Expire stale requests. An approval from last week is not consent today. */
  expireOlderThan(cutoff: Date): number {
    const res = this.#db.prepare(
      "UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND requested_at < ?",
    ).run(cutoff.toISOString());
    return Number(res.changes);
  }
}

/** Why an approval whose page has gone ends without anything being pressed. */
export const WINDOW_CLOSED = 'the window it was for is closed, so nothing was pressed';

/** What the owner and the agent are told about carrying out an approval. */
export const COPY = {
  noAnswer: 'the browser stopped answering in that tab, so whether it went cannot be told; read the page before pressing it again',
  /** On the application, when a press after the user's approval showed no confirmation. */
  pressedNoConfirmation: 'Pressed after your approval, and no confirmation was seen. Check it.',
  /** The same for a press the user's "Submit applications without asking me" let go. */
  sentNoConfirmation: 'Sent without asking, as you set. The page didn’t show a confirmation, so check it.',
};

const AGAIN = '; approve it again as it is now';
const DRAFT_CHANGED = 'the text in the field is not the draft that was approved; re-approve before sending';

/** Not carried out because what was approved changed after it: only a new card, from pressing it again, can be approved. */
export function changedAfterApproval(detail: string | null): boolean {
  return detail === DRAFT_CHANGED || /^the form changed after it was approved \(.*\); approve it again as it is now$/.test(detail ?? '');
}

/** Action kinds whose approved content is the value to send. */
const CARRIES_VALUE = new Set(['fill', 'type', 'select']);

export type ResumeOutcome =
  | { performed: true; result: 'ok'; detail: string }
  | { performed: false; reason: 'not_approved' | 'target_gone' | 'content_changed' | 'failed' | 'refused_by_page'; detail: string }
  /** Pressed, and whether it went through cannot be told: the approval is spent. */
  | { performed: false; reason: 'unknown'; detail: string };

export interface PerformOptions {
  documents?: { uploadableDocument(id: string): { path: string; title: string } | null };
  /** When present, an approved contact is checked against, and recorded in, episodic memory. */
  memory?: Memory;
  /** When present, a submission is checked against the site's terms again, on the page as it is now. */
  sites?: SitePolicies;
  /** When present, an application that went out is marked in the ledger. */
  jobs?: Jobs;
  /** The ledger's application this press finishes, when it is on a page of its own, such as the code a site emailed at /verify. */
  application?: string | null;
}

/**
 * Carry out a previously approved action against the page as it is NOW.
 *
 * Re-observes, re-locates the approved target by role and accessible name, and
 * verifies the content still matches what was approved before doing anything.
 */
export async function performApproved(
  approvals: Approvals,
  page: BrowserRuntime | null,
  id: string,
  opts: PerformOptions = {},
): Promise<ResumeOutcome> {
  if (!approvals.claim(id)) {
    const request = approvals.get(id);
    if (!request) return { performed: false, reason: 'not_approved', detail: `no such approval: ${id}` };
    const { status } = request;
    return {
      performed: false, reason: 'not_approved',
      detail: status === 'performing' ? 'it is already being carried out' : status === 'consumed' ? 'it was already carried out'
        : request.outcome === 'not_done' && request.outcomeDetail ? request.outcomeDetail : `approval is ${status}, not approved`,
    };
  }
  // Only the page it was asked on will do: the same form open in another window is not what was approved.
  if (!page) {
    approvals.end(id, WINDOW_CLOSED);
    return { performed: false, reason: 'target_gone', detail: WINDOW_CLOSED };
  }
  // Once the press is on its way nothing may hand the approval back: a
  // timeout or a lost connection after it says nothing about whether it landed.
  const pressed = { dispatched: false };
  try {
    const outcome = await performClaimed(page, approvals.get(id)!, opts, pressed);
    if (outcome.performed) approvals.settle(id, 'sent', outcome.detail);
    else if (outcome.reason === 'refused_by_page') approvals.settle(id, 'refused', outcome.detail);
    else if (outcome.reason === 'unknown') approvals.settle(id, 'unknown', outcome.detail);
    else approvals.release(id, outcome.detail);
    return outcome;
  } catch (err) {
    // A tab that stopped answering cannot say what it shows or what a press did: the user reads it, it is not pressed again blind.
    if (isNoAnswer(err) || (pressed.dispatched && isTransportLoss(err))) {
      const outcome: ResumeOutcome = { performed: false, reason: 'unknown', detail: COPY.noAnswer };
      approvals.settle(id, 'unknown', outcome.detail);
      return outcome;
    }
    if (!pressed.dispatched) {
      approvals.release(id, `it could not be carried out: ${(err as Error).message}`);
      throw err;
    }
    const outcome = mayHaveGone(`the browser failed during the press (${(err as Error).message})`);
    approvals.settle(id, 'unknown', outcome.detail);
    return outcome;
  }
}

function mayHaveGone(why: string): ResumeOutcome {
  return {
    performed: false, reason: 'unknown',
    detail: `${why}, so it may have been sent; check the page before pressing it again`,
  };
}

async function performClaimed(
  page: BrowserRuntime,
  req: ApprovalRequest,
  opts: PerformOptions,
  pressed: { dispatched: boolean },
): Promise<ResumeOutcome> {
  const observation = await page.observe();

  if (observation.url !== req.url) {
    return {
      performed: false, reason: 'target_gone',
      detail: `approved on ${req.url}, page is now ${observation.url}`,
    };
  }

  const sameControl = (n: typeof observation.nodes[number]): boolean =>
    n.role === req.targetRole &&
    (n.name ? unwrapUntrustedForDisplay(n.name) : null) === req.targetName &&
    // An unnamed file input and the heading beside it can share a role and a
    // null name. What the control structurally IS has to match too.
    (n.evidence?.inputType ?? null) === req.targetInputType;

  const matches = observation.nodes.filter(sameControl);
  if (matches.length === 0) {
    return {
      performed: false, reason: 'target_gone',
      detail: `no ${req.targetRole} named "${req.targetName}" on the page any more`,
    };
  }
  if (matches.length > 1) {
    // Ambiguity is not something to resolve by guessing when the action
    // contacts someone.
    return {
      performed: false, reason: 'target_gone',
      detail: `${matches.length} elements now match ${req.targetRole} "${req.targetName}"; refusing to guess`,
    };
  }

  // For an upload, `content` is a document id, not text: there is nothing to
  // edit and nothing to compare against a composer.
  const approvedContent = req.actionKind === 'upload' ? null : (req.editedContent ?? req.content);
  if (approvedContent !== null && req.actionKind !== 'fill') {
    /*
     * Has the page moved on since the card was shown? The composer should
     * still hold the DRAFT the person saw — req.content — not the text they
     * approved. When they edited it, those differ by construction, and the
     * edit is applied below; comparing against the edit here would refuse
     * every edited approval on a real page, where the composer keeps its value.
     */
    const onPage = composerContent(observation);
    if (onPage !== null && req.content !== null && onPage !== req.content) {
      return { performed: false, reason: 'content_changed', detail: DRAFT_CHANGED };
    }
  }

  // An approval is not a way around the hand-overs: on a page that now asks
  // for a video or a test, or on a site whose terms keep Submit the person's,
  // the person finishes it themselves.
  if (req.sensitivity === 'CONTACT_EXTERNAL') {
    const theirs = humanOnly(observation, matches[0]);
    if (theirs) {
      return { performed: false, reason: 'not_approved', detail: `the application asks for ${theirs.what}, which only you can do; finish it and press Submit yourself` };
    }
    if (opts.sites?.submitMode(observation.url)?.mode === 'prepare') {
      return { performed: false, reason: 'not_approved', detail: 'this site\'s terms keep Submit yours; press it yourself in the Fanfold window' };
    }
  }

  // The card showed what the form held. If it holds something else now, the
  // person approved a different application from the one that would go.
  if (req.form) {
    const now = formContents(observation, submitted(observation, matches[0], req.actionKind), req.why) ?? [];
    const changed = req.form.find((f, i) => now[i]?.label !== f.label || now[i]?.value !== f.value)
      ?? (now.length !== req.form.length ? now[req.form.length] ?? req.form[now.length] : undefined);
    if (changed) {
      return { performed: false, reason: 'content_changed', detail: `the form changed after it was approved (${JSON.stringify(changed.label)})${AGAIN}` };
    }
  }

  // If the user edited the draft, put their exact words in first.
  const edit = req.editedContent !== req.content ? req.editedContent : null;
  if (edit !== null) {
    const composer = observation.nodes.find(isComposer);
    if (!composer?.ref) {
      return { performed: false, reason: 'target_gone', detail: 'cannot find the field the edited text belongs in' };
    }
    const fill = await page.act({
      kind: 'fill', ref: composer.ref as Ref,
      pageStateId: observation.pageStateId as PageStateId,
      value: edit,
    });
    if (!fill.ok) {
      return { performed: false, reason: 'failed', detail: `could not apply the edited text: ${fill.failure}` };
    }
  }

  // Re-observe after any edit: the fill minted a new page state.
  const fresh = edit !== null ? await page.observe() : observation;
  const target = fresh.nodes.find(sameControl);
  if (!target?.ref) {
    return { performed: false, reason: 'target_gone', detail: 'the approved control disappeared while applying the edit' };
  }

  const request: ActionRequest = {
    kind: req.actionKind as ActionRequest['kind'],
    ref: target.ref as Ref,
    pageStateId: fresh.pageStateId as PageStateId,
    // The approved text is the value for anything that carries one; a click has none.
    value: CARRIES_VALUE.has(req.actionKind) ? (approvedContent ?? undefined) : undefined,
  };

  /*
   * An upload carries a document, and the document has to be turned back into
   * a file HERE — the same way the loop does it, from the id the approval
   * recorded. Without it the approved action would dispatch with no files at
   * all, and approving an upload could never perform one.
   *
   * Resolved at execution rather than stored as a path at request time, so a
   * document deleted between asking and approving is refused instead of
   * reaching for a file that is no longer there.
   */
  if (req.actionKind === 'upload') {
    const documentId = req.content;
    const document = documentId ? opts.documents?.uploadableDocument(documentId) ?? null : null;
    if (!document) {
      return {
        performed: false, reason: 'target_gone',
        detail: documentId
          ? `the document approved for upload (${documentId}) is no longer available`
          : 'the approval did not record which document to attach',
      };
    }
    request.files = [document.path];
    request.value = undefined;
  }

  // Who this reaches, read from the page as it is now, against the same
  // identity table the loop consults. A card that did not tell its reader
  // about an earlier contact does not cover a second message: it was
  // approved without knowing. One that did is the person deciding to send
  // again.
  let recipientKey: string | null = null;
  if (opts.memory && req.sensitivity === 'CONTACT_EXTERNAL') {
    const who = deriveRecipient(fresh);
    if (who) {
      recipientKey = opts.memory.personKey(who.id);
      opts.memory.surface({ identityKey: recipientKey, kind: 'person', displayName: who.display, runId: req.runId });
      const contactedAt = opts.memory.contactedAt(recipientKey);
      // The mark moves with every contact, so a card raised before the latest
      // one no longer matches, however many were pending.
      if (contactedAt && opts.memory.contactMark(recipientKey) !== req.priorContactAt) {
        return {
          performed: false, reason: 'not_approved',
          detail: `something was already sent to ${who.display} on ${whenSaid(contactedAt)}, which this approval was given without knowing; not sending again on it`,
        };
      }
    }
  }

  pressed.dispatched = true;
  let result: ActionResult;
  try {
    result = await page.act(request);
  } catch (err) {
    result = { ok: false, failure: 'CDP_ERROR', detail: (err as Error).message, navigated: false, ms: 0 };
  }
  if (!result.ok && NO_EFFECT_FAILURES.has(result.failure ?? '')) {
    pressed.dispatched = false;
    return { performed: false, reason: 'failed', detail: `${result.failure}: ${result.detail ?? ''}` };
  }
  // Only a click or a key press sends a form. A ticked box sends nothing,
  // and counting it as contact would make the real Submit look like a second one.
  const sends = req.actionKind === 'click' || req.actionKind === 'press';
  if (!result.ok) {
    if (sends) noteSent(req, null, recipientKey, approvedContent, opts, 'unconfirmed');
    return mayHaveGone(`the press did not come back cleanly (${result.failure}: ${result.detail ?? ''})`);
  }

  const after = sends ? await outcomeOf(page, fresh, target) : null;
  // An "Apply now" that opened the application's form sent nothing yet:
  // counted as contact, it would make the form's own Submit look like a second one.
  if (after && STARTS.test(req.targetName ?? '') && fillable(after) > fillable(fresh)) {
    return { performed: true, result: 'ok', detail: `performed ${req.actionKind} on ${req.targetRole} "${req.targetName}", ${OPENED_FORM}` };
  }
  // A submit the form turned away reached nobody: say so, and record no
  // contact, so the corrected one is not taken for a second application.
  const refused = after && after.url === req.url ? pageRefused(after, fresh, target) : null;
  if (refused) {
    return {
      performed: false, reason: 'refused_by_page',
      detail: `the page did not accept it (${refused}). Nothing reached anyone; put right what it says and press it again`,
    };
  }
  if (sends) noteSent(req, after, recipientKey, approvedContent, opts, after && confirmationIn(after) ? 'applied' : 'unconfirmed');
  return { performed: true, result: 'ok', detail: `performed ${req.actionKind} on ${req.targetRole} "${req.targetName}"` };
}

/** Record what went out: one more contact with this person, and the application in the ledger. */
function noteSent(
  req: ApprovalRequest, after: Observation | null, recipientKey: string | null, approvedContent: string | null,
  opts: PerformOptions, status: 'applied' | 'unconfirmed',
): void {
  if (recipientKey && opts.memory) {
    const sent = approvedContent ?? req.actionKind;
    if (opts.memory.contactMark(recipientKey)) opts.memory.recordRepeatContact(recipientKey, 'browser', sent);
    else try { opts.memory.recordContact(recipientKey, 'browser', sent); } catch { /* already recorded */ }
  }
  if (opts.jobs && req.sensitivity === 'CONTACT_EXTERNAL') {
    try {
      opts.jobs.markSubmitted({
        url: req.url, pageTitle: req.pageTitle, runId: req.runId, status, applicationId: opts.application ?? null,
        confirmation: (after && confirmationIn(after))
          ?? (status === 'unconfirmed' ? (/without asking/.test(req.answeredNote ?? '') ? COPY.sentNoConfirmation : COPY.pressedNoConfirmation) : null),
        // Only a page that names itself an application makes a new row; one already known is updated whatever it says.
        isApplication: APPLICATION.test(unaccented([req.why, req.targetName ?? '', req.pageTitle ?? '', req.url].join(' '))),
      });
    } catch {
      // The ledger is a record of what happened; failing to write it does not change what happened.
    }
  }
}

const OPENED_FORM = 'which opened the application form';

/** Carried out, and all it did was open the application's form: nothing reached anyone. */
export function openedFormOnly(request: Pick<ApprovalRequest, 'outcome' | 'outcomeDetail'> | null | undefined): boolean {
  return request?.outcome === 'sent' && !!request.outcomeDetail?.includes(OPENED_FORM);
}

const APPLICATION = /\b(apply|application|applying|candidate|resume|cv)\b/i;
/** Buttons that begin an application. On a one-click board the same button sends it, and no form follows. */
const STARTS = /^(easy apply|apply( now| today| here| online)?( for| to)?( this| the)?( job| role| position)?|i['’]?m interested|start (my |your |an )?application)\b/i;

function fillable(obs: Observation): number {
  return obs.nodes.filter((n) => n.evidence?.control && !n.state.disabled).length;
}
const CONFIRMED = /\b(application (was |has been )?(received|submitted|sent)|thank(s| you) for (applying|your application)|we('ve| have) received your application)\b/i;

/** What a page says once an application has gone through, if it says anything. */
export function confirmationIn(obs: Observation): string | null {
  for (const node of obs.nodes) {
    for (const text of [node.name, node.text]) {
      if (!text) continue;
      const shown = unwrapUntrustedForDisplay(text);
      if (CONFIRMED.test(shown)) return shown.slice(0, 200);
    }
  }
  // A form that says so only in the tab's title ("Application submitted") has said so too.
  const title = obs.title ? unwrapUntrustedForDisplay(obs.title) : '';
  return CONFIRMED.test(title) ? title.slice(0, 200) : null;
}

const BUSY = /\b(submitting|sending|processing|uploading|loading|please wait|saving)\b/i;
const SETTLE_MS = 10_000;
const SETTLE_POLL_MS = 250;

/**
 * The page once it has answered the press. A form that says it is sending is
 * given a few seconds to say how it went: read at once, the answer is not
 * there yet, and a failure taken for a send costs the person a second card
 * warning of a duplicate that never went.
 */
async function outcomeOf(page: BrowserRuntime, before: Observation, target: ObservedNode): Promise<Observation | null> {
  const deadline = Date.now() + SETTLE_MS;
  const busyBefore = new Set(before.nodes.filter(isBusy).map(words));
  for (;;) {
    const after = await page.observe().catch(() => null);
    if (!after || after.url !== before.url || Date.now() >= deadline) return after;
    const still = after.nodes.some((n) => isBusy(n) && !busyBefore.has(words(n)))
      || after.nodes.some((n) => n.ref === target.ref && n.state.disabled && !target.state.disabled);
    if (!still) return after;
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
}

function isBusy(n: ObservedNode): boolean {
  return (n.role === 'status' || n.role === 'progressbar' || n.role === 'alert') && BUSY.test(words(n));
}

const words = (n: ObservedNode): string => [n.text, n.name].filter(Boolean).map((t) => unwrapUntrustedForDisplay(t!)).join(' ').trim();

const FAILED = /\b(errors?|required|invalid|missing|fix|problem|went wrong|try again|failed|could not|couldn['’]t|unable|not (be )?(sent|submitted|saved))\b/i;

/**
 * Did the form turn the submit away? Only what the press itself brought on
 * counts, and only in the form that was sent: an alert or a field already
 * marked before the click, a hint read as an error, or a banner elsewhere on
 * the page says nothing about this submit. Read wrongly the other way, a
 * submit that went is taken for one that did not, and sent a second time.
 */
function pageRefused(after: Observation, before: Observation, target: ObservedNode): string | null {
  const inScope = scopeOf(after, target);
  const seen = new Set(before.nodes.map(words));
  // A message drawn as plain text inside an alert box reads the same as the box.
  const said = (roles: string[]): ObservedNode | undefined => after.nodes.find((n, i) => inScope(i) && roles.includes(n.role)
    && !seen.has(words(n)) && FAILED.test(words(n)) && !CONFIRMED.test(words(n)));
  const alert = said(['alert', 'status']) ?? said(['text', 'paragraph']);
  const marked = (n: ObservedNode): string => `${n.ref}\u0000${n.state.error ?? ''}`;
  const wasWrong = new Set(before.nodes.filter((n) => n.state.invalid && n.ref).map(marked));
  // A field that only shares a box with the message is not one it is about.
  const invalid = after.nodes.filter((n, i) => inScope(i) && n.state.invalid && n.name && n.ref && !wasWrong.has(marked(n))
    && !(alert && n.state.error === words(alert)))
    .map((n) => unwrapUntrustedForDisplay(n.name!)).slice(0, 5);
  if (!alert && !invalid.length) return null;
  const message = alert ? JSON.stringify(fence(words(alert).slice(0, 160))) : '';
  const fields = invalid.length ? `fields marked wrong: ${invalid.map((f) => JSON.stringify(fence(f.slice(0, 60)))).join(', ')}` : '';
  return [message, fields].filter(Boolean).join('; ');
}

/**
 * Which part of the page belongs to the form that was sent: its own controls
 * and what lies between them, or, for a button outside any form, everything
 * outside the page's forms.
 */
function scopeOf(obs: Observation, target: ObservedNode): (i: number) => boolean {
  const at = obs.nodes.findIndex((n) => n.ref === target.ref);
  const form = (at >= 0 ? obs.nodes[at].evidence : undefined) ?? target.evidence;
  if (!form?.inForm) {
    // No form to go by: its dialog, or from the first loose field to just past the button.
    const dialog = dialogAround(obs, at);
    if (dialog) return (i) => i > dialog[0] && i < dialog[1];
    const loose = obs.nodes.findIndex((n) => n.evidence?.control && !n.evidence.inForm);
    const from = Math.min(loose < 0 ? at : loose, at) - 1;
    const to = at < 0 ? -1 : at + 4;
    return (i) => !obs.nodes[i].evidence?.inForm && i > from && i < to;
  }
  const own = obs.nodes.flatMap((n, i) => (n.evidence?.inForm && sameForm(n.evidence, form) ? [i] : []));
  const first = Math.min(...own, at < 0 ? Infinity : at);
  const last = Math.max(...own, at);
  return (i) => i >= first && i <= last && (!obs.nodes[i].evidence?.inForm || sameForm(obs.nodes[i].evidence!, form));
}

/** The control a press sends from: the one clicked, or for a key, whatever has focus. */
function submitted(obs: Observation, target: ObservedNode, kind: string): ObservedNode {
  return kind === 'press' ? obs.nodes.find((n) => n.evidence?.focused) ?? target : target;
}

/** Same form: by its place among the page's forms when known, else by where it posts. */
function sameForm(a: ActionEvidence, b: ActionEvidence): boolean {
  if (a.formIndex !== undefined && b.formIndex !== undefined) return a.formIndex === b.formIndex;
  return a.formMethod === b.formMethod && a.formActionOrigin === b.formActionOrigin;
}

function isComposer(n: ObservedNode): boolean {
  return n.role === 'textbox' && !!n.name && /message|comment|reply|post|body|note/i.test(unwrapUntrustedForDisplay(n.name));
}

function composerContent(obs: Observation): string | null {
  const composer = obs.nodes.find(isComposer);
  return composer?.value ? unwrapUntrustedForDisplay(composer.value) : null;
}

const MAX_FORM_FIELDS = 60;
const REVIEW_HEADING = /^\s*review\b/i;
/** How many nodes above the submit a review step's heading is looked for. */
const REVIEW_LOOKBACK = 600;
const LINE_ROLES = new Set(['text', 'paragraph', 'listitem', 'cell', 'columnheader', 'rowheader', 'term', 'definition']);
const QUESTION = /\?\s*\*?$/;
const FILE_NAME = /\.(pdf|docx?|rtf|txt|odt)$/i;

/**
 * What a submit would send, as the page reports it, for a person about to
 * approve it. Read from the observation, never from the model's account.
 *
 * A last step that lists the answers as text ("Review your application")
 * shows every line of it, then whatever its own form still holds. A button in
 * a form shows that form. A button in no form shows the page's loose fields
 * only when it sends an application: a message's Send has no form to show.
 */
function formContents(obs: Observation, target: ObservedNode | undefined, why: string): FormField[] | null {
  if (!target) return null;
  const at = obs.nodes.indexOf(target);
  const reviewAt = reviewHeading(obs, at);
  const own = target.evidence;
  const fields: FormField[] = reviewAt >= 0 ? reviewedAnswers(obs, reviewAt, at) : [];
  let belongs: ((n: ObservedNode, i: number) => boolean) | null = null;
  if (own?.inForm) belongs = (n) => !!n.evidence?.inForm && sameForm(n.evidence, own);
  else if (reviewAt >= 0) belongs = (n, i) => !n.evidence?.inForm && i > reviewAt && i < at;
  else {
    // A button in no form sends what its dialog holds, or on a page that is an
    // application, the page's loose fields. A message has no form to show.
    const box = dialogAround(obs, at);
    const loose = (n: ObservedNode, i: number): boolean => (box ? i > box[0] && i < box[1] : !n.evidence?.inForm);
    const message = obs.nodes.some((n, i) => loose(n, i) && isComposer(n) && n.value);
    if ((box || APPLICATION.test(unaccented(why))) && !message) belongs = loose;
  }
  if (belongs) fields.push(...fieldsOf(obs, belongs));
  return fields.length ? fields.slice(0, MAX_FORM_FIELDS) : null;
}

/**
 * The dialog a node sits in, as [its index, the index past its last node].
 * Nodes come in document order with their depth, so the dialog is the
 * nearest node above at a lower depth that is one.
 */
function dialogAround(obs: Observation, at: number): [number, number] | null {
  if (at < 0) return null;
  let depth = obs.nodes[at].depth;
  const last = seamAfter(obs, at);
  for (let i = at - 1; i >= seamBefore(obs, at) && depth > 0; i--) {
    const n = obs.nodes[i];
    if (n.depth >= depth) continue;
    depth = n.depth;
    if (n.role === 'dialog' || n.role === 'alertdialog') {
      let end = i + 1;
      while (end < last && obs.nodes[end].depth > n.depth) end++;
      return [i, end];
    }
  }
  return null;
}

function reviewHeading(obs: Observation, at: number): number {
  for (let i = at - 1; i >= 0 && at - i <= REVIEW_LOOKBACK; i--) {
    const n = obs.nodes[i];
    if (n.role === 'heading' && n.name && REVIEW_HEADING.test(unwrapUntrustedForDisplay(n.name))) return i;
  }
  return -1;
}

/**
 * The lines a review step shows between its heading and the submit, each
 * label with the line after it. Nothing is dropped: a line with no partner,
 * such as a date under the résumé, is shown on its own.
 */
function reviewedAnswers(obs: Observation, from: number, to: number): FormField[] {
  const fields: FormField[] = [];
  let lines: string[] = [];
  const flush = (): void => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const next = lines[i + 1];
      if (FILE_NAME.test(line)) fields.push({ label: 'Résumé', value: line.slice(0, 200) });
      else if (next !== undefined && !QUESTION.test(next)) {
        fields.push({ label: line.replace(/\s*\*$/, '').slice(0, 120), value: next.slice(0, 500) });
        i++;
      } else fields.push({ label: '', value: line.slice(0, 500) });
    }
    lines = [];
  };
  let control: ObservedNode | null = null;
  for (let i = from + 1; i < to; i++) {
    const n = obs.nodes[i];
    // A section heading, an Edit button or a field ends a run of lines.
    if (n.role === 'heading' || n.evidence || (n.ref && !LINE_ROLES.has(n.role))) {
      flush();
      // The summary ends where the step's own fields begin: what follows is
      // the footer, and the page's messages about the submit itself.
      if (n.evidence?.control) break;
      if (n.evidence || n.ref) control = n;
      continue;
    }
    // A button's own words are not lines of the review.
    if (control && n.depth > control.depth) continue;
    control = null;
    if (!LINE_ROLES.has(n.role)) continue;
    const line = words(n);
    if (line) lines.push(line);
  }
  flush();
  return fields;
}

function fieldsOf(obs: Observation, belongs: (n: ObservedNode, i: number) => boolean): FormField[] {
  const fields: FormField[] = [];
  obs.nodes.forEach((node, i) => {
    if (fields.length >= MAX_FORM_FIELDS || !node.evidence || !belongs(node, i)) return;
    const control = node.evidence.control;
    // A dropdown built from divs has no native control, yet holds an answer,
    // and so does a pressed Yes/No toggle under its question.
    if (node.role === 'button' && node.state.pressed === true && node.evidence.group) {
      fields.push({ label: node.evidence.group.slice(0, 120), value: node.name ? unwrapUntrustedForDisplay(node.name) : 'pressed' });
      return;
    }
    if (!control && node.role !== 'combobox') return;
    const raw = node.value ? unwrapUntrustedForDisplay(node.value) : '';
    let value = raw;
    if (control === 'checkbox') value = node.state.checked === true ? 'yes' : 'no';
    const question = control === 'radio' ? node.evidence.group : undefined;
    if (control === 'radio') {
      if (node.state.checked !== true) return;
      // With its group's question as the label, the button's own label is the answer.
      value = question && node.name ? unwrapUntrustedForDisplay(node.name) : 'chosen';
    } else if (control === 'file') value = raw.replace(/^C:\\fakepath\\/i, '');
    const own = node.name ? unwrapUntrustedForDisplay(node.name).replace(/\s*\*$/, '') : node.role;
    // "Yes" needs the statement it agrees to; a box that is its own sentence does not.
    const asks = control === 'checkbox' && own.length <= 40 ? node.evidence.group : undefined;
    const label = question ?? (asks ? `${asks} — ${own}` : own);
    const required = node.state.required === true || node.evidence.groupRequired === true;
    fields.push({ label: label.slice(0, 120), value: value.slice(0, 500), ...(required ? { required } : {}) });
  });
  return fields;
}

function parseForm(raw: unknown): FormField[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as FormField[] : null;
  } catch {
    return null;
  }
}

function toRequest(row: Record<string, unknown>): ApprovalRequest {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stepIdx: Number(row.step_idx),
    status: String(row.status) as ApprovalStatus,
    sensitivity: String(row.sensitivity) as Sensitivity,
    why: String(row.why),
    url: String(row.url),
    actionKind: String(row.action_kind),
    targetRole: row.target_role === null ? null : String(row.target_role),
    targetName: row.target_name === null ? null : String(row.target_name),
    targetInputType: row.target_input_type == null ? null : String(row.target_input_type),
    content: row.content === null ? null : String(row.content),
    editedContent: row.edited_content === null ? null : String(row.edited_content),
    form: parseForm(row.form),
    askedBy: row.asked_by == null ? null : String(row.asked_by),
    priorContactAt: row.prior_contact_at == null ? null : String(row.prior_contact_at),
    pageTitle: row.page_title == null ? null : String(row.page_title),
    requestedAt: String(row.requested_at),
    answeredAt: row.answered_at == null ? null : String(row.answered_at),
    outcome: row.outcome == null ? null : String(row.outcome) as ApprovalOutcome,
    outcomeDetail: row.outcome_detail == null ? null : String(row.outcome_detail),
    answeredNote: row.answered_note == null ? null : String(row.answered_note),
  };
}
