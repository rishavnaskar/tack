/**
 * One queue for every call Fanfold makes on the user's behalf while a form
 * waits: reading a résumé, classifying a form's questions, checking an
 * answer, drafting an essay, reading a posting's requirements.
 *
 * Eight sessions filling forms at once would otherwise send eight calls at
 * once and run into the provider's rate limit together. At most three are in
 * flight; each has its own deadline, and is tried once more only when the
 * provider says it is busy, inside that deadline: a form is better served by
 * "ask the user" now than by an answer in two minutes.
 */
import type { ModelLike } from '../agent/loop.ts';
import { providerSaid, type CompleteOptions, type Completion } from './client.ts';
import type { Tier } from './pricebook.ts';

export class Limiter {
  readonly max: number;
  #inFlight = 0;
  readonly #queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // A finished call hands its place straight to the next in line, so a newcomer cannot slip in between.
    if (this.#inFlight < this.max) this.#inFlight++;
    else await new Promise<void>((resolve) => this.#queue.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#inFlight--;
    }
  }
}

/** The one limiter for answer-tier calls. */
const ANSWER_CALLS = new Limiter(3);

const ANSWER_TIMEOUT_MS = 25_000;

/** How long a call the provider turned away for being busy waits before its one more try. */
const RETRY_AFTER_MS = 1_500;

/** What the owner reads when Fanfold's own model keeps failing, in words they can act on. */
export const COPY = {
  busy: 'Fanfold’s AI is unavailable right now ({reason}). Questions that need it will wait for you, and Fanfold will try again automatically.',
  slow: 'Fanfold’s AI is taking too long to respond right now ({reason}). Questions that need it will wait for you, and Fanfold will try again automatically.',
  failing: 'Fanfold’s AI ran into an error ({reason}). Questions that need it will wait for you, and Fanfold will try again automatically.',
  noReason: 'no reason given',
  reasonBusy: 'the provider is temporarily rejecting requests: {said}',
  reasonSlow: 'it did not respond in time: {said}',
  reasonBroken: 'the provider ran into a problem: {said}',
  quota: 'Fanfold’s AI key is out of quota, so questions that need it wait for you until the quota resets or another key or a fallback model is set.',
  paused: 'the provider asked Fanfold to wait {seconds} s before asking again',
};

/** The provider said it is busy or broken, not that the request was wrong: worth one more try. */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const statusOf = (err: unknown): number | null => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
};
const waitOf = (err: unknown): number | null => {
  const w = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof w === 'number' && w > 0 ? w : null;
};
/** A 429 that is about the key's quota, not a moment's load. */
const outOfQuota = (err: unknown): boolean => statusOf(err) === 429 && /quota|resource.?exhausted|exceeded/i.test(err instanceof Error ? err.message : String(err ?? ''));

/** Until when a model asked not to be called again, by model: honoured by every answer-tier call. */
const PAUSED = new WeakMap<object, number>();

/** A call not made because the provider asked Fanfold to wait longer than this call can. */
class Paused extends Error {
  readonly status = 429;
  constructor(ms: number) {
    super(COPY.paused.replace('{seconds}', String(Math.ceil(ms / 1000))));
  }
}

/** How a model's recent answer-tier calls went, so a model that keeps failing is said, not silent. */
class Health {
  #recent: boolean[] = [];
  problem: string | null = null;

  note(ok: boolean, err?: unknown): void {
    this.#recent = [...this.#recent, ok].slice(-5);
    if (ok) this.problem = null;
    // Out of quota is said at once: no number of tries will change it until the quota resets.
    else if (outOfQuota(err)) this.problem = COPY.quota;
    else if (this.#recent.filter((x) => !x).length >= 2) this.problem = plainFailure(err);
  }
}

const HEALTH = new WeakMap<object, Health>();

/** A model given another key starts again with a clean record: no failures, and no wait the old key was asked for. */
export function forgetHealth(model: object): void {
  HEALTH.delete(model);
  PAUSED.delete(model);
}

/** Why this model is failing, in plain words, when two of its last five answer-tier calls failed; null since its last success. */
export function answerModelHealth(model: ModelLike | null | undefined): string | null {
  return model ? HEALTH.get(model)?.problem ?? null : null;
}

/** What the provider said, as words: never its JSON, and cut at a word, not inside one. */
function said(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const words = providerSaid(message.replace(/^HTTP \d{3}:\s*/, '').replace(/^provider error:\s*/, ''));
  if (words.length <= 160) return words || COPY.noReason;
  return `${words.slice(0, 160).replace(/\s+\S*$/, '')}…`;
}

/** A failure as the owner reads it: what the provider said, without the codes. */
export function plainFailure(err: unknown): string {
  const status = statusOf(err);
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (outOfQuota(err)) return COPY.quota;
  if (status === 429) return COPY.busy.replace('{reason}', said(err));
  if (/no reply within|timed? ?out|timeout/i.test(message)) return COPY.slow.replace('{reason}', said(err));
  if (status !== null && status >= 500) return COPY.busy.replace('{reason}', said(err));
  return COPY.failing.replace('{reason}', said(err));
}

/** Why a call failed, in a few plain words for the card that started it: what the provider said, without the codes. */
export function plainReason(err: unknown): string {
  const status = statusOf(err);
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (status === 429) return COPY.reasonBusy.replace('{said}', said(err));
  if (/no reply within|timed? ?out|timeout/i.test(message)) return COPY.reasonSlow.replace('{said}', said(err));
  if (status !== null && status >= 500) return COPY.reasonBroken.replace('{said}', said(err));
  return said(err);
}

/**
 * One answer-tier call through the limiter, with its own deadline. A
 * provider that says it is busy or broken (429, 500, 502, 503, 504) gets one
 * more try 1.5 s later, inside the same deadline; a call that ran out of
 * time is not tried again. A model that ignores the abort still gives up at
 * the deadline.
 */
export async function answerCall<T>(
  model: ModelLike,
  opts: Omit<CompleteOptions, 'tier' | 'signal' | 'retries'> & { schema: NonNullable<CompleteOptions['schema']> },
  o: { timeoutMs?: number; signal?: AbortSignal; tier?: Tier; limiter?: Limiter } = {},
): Promise<Completion<T>> {
  const health = HEALTH.get(model) ?? new Health();
  HEALTH.set(model, health);
  return (o.limiter ?? ANSWER_CALLS).run(async () => {
    o.signal?.throwIfAborted();
    // A timer of its own rather than AbortSignal.timeout: that one does not keep the process alive, and a call must end in an answer or an error.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error(`no reply within ${Math.round((o.timeoutMs ?? ANSWER_TIMEOUT_MS) / 1000)} s`)), o.timeoutMs ?? ANSWER_TIMEOUT_MS);
    const signal = o.signal ? AbortSignal.any([o.signal, deadline.signal]) : deadline.signal;
    const stopped = new Promise<never>((_, reject) => {
      const stop = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('the call was stopped'));
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });
    stopped.catch(() => {});
    const once = (id?: string): Promise<Completion<T>> => Promise.race([model.completeJson<T>({ ...opts, tier: o.tier ?? 'answer', retries: 0, signal, ...(id ? { model: id } : {}) }), stopped]);
    const ends = Date.now() + (o.timeoutMs ?? ANSWER_TIMEOUT_MS);
    const fallback = model.answerFallback ?? null;
    const sleep = (ms: number): Promise<unknown> => Promise.race([new Promise((r) => setTimeout(r, ms)), stopped]);
    /** The model is asked again only when the wait it named fits this call; otherwise this call gives up now rather than ask into it. */
    const primary = async (): Promise<Completion<T>> => {
      const until = PAUSED.get(model) ?? 0;
      if (until > Date.now()) {
        if (until >= ends) throw new Paused(until - Date.now());
        await sleep(until - Date.now());
      }
      return once();
    };
    try {
      let result: Completion<T>;
      try {
        result = await primary();
      } catch (err) {
        if (signal.aborted || !RETRY_STATUS.has(statusOf(err) ?? 0)) throw err;
        const wait = waitOf(err);
        if (wait !== null) PAUSED.set(model, Date.now() + wait);
        if (fallback) {
          // A second model, once: it has its own limits, so the first one's wait does not apply to it.
          result = await once(fallback);
        } else {
          const pause = wait ?? RETRY_AFTER_MS;
          if (err instanceof Paused || Date.now() + pause >= ends) throw err;
          await sleep(pause);
          result = await once();
        }
      }
      health.note(true);
      return result;
    } catch (err) {
      health.note(false, err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  });
}
