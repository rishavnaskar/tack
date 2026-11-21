/**
 * Model client.
 *
 * One interface over the tiers, so no DeepSeek or OpenRouter specific detail
 * leaks into the orchestrator — the model layer has to stay swappable, since
 * long-horizon tool-call reliability is the axis on which a cheap model is
 * most likely to become the ceiling.
 *
 * Three things this does that a thin fetch wrapper would not:
 *
 *  1. Reasoning is explicit. Both the vision Flash and Pro emit reasoning
 *     tokens by default; a 10-token budget is consumed entirely by reasoning
 *     and the call returns null content. Routine per-step selection asks for
 *     none, planning asks for more.
 *  2. Structured output is a schema, not a plea. The step model returns a
 *     validated object or the call fails — no parsing prose.
 *  3. Every call produces a UsageEvent priced against a versioned book.
 */

import { MODELS, computeCost, effectiveCost, PRICE_BOOK_VERSION, UNPRICED, unpriced, type Tier, type UsageEvent } from './pricebook.ts';

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export interface CompleteOptions {
  tier?: Tier;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  reasoning?: ReasoningEffort;
  /** JSON Schema the reply must satisfy. */
  schema?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
  /** Retries for this call alone; the client's own count otherwise. A form waiting on an answer is not kept waiting through backoffs. */
  retries?: number;
  /** Another model id for this call alone, such as the answer tier's fallback. */
  model?: string;
}

export interface Completion<T = string> {
  content: T;
  usage: UsageEvent;
  raw: string;
}

export class ModelError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  /** How long the provider said to wait before asking again, when it said. */
  readonly retryAfterMs: number | null;
  constructor(message: string, status: number | null, retryable: boolean, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ModelClientOptions {
  apiKey: string;
  /**
   * Any OpenAI-compatible endpoint: its base (…/v1) or its chat-completions
   * URL. FANFOLD_MODEL_URL when absent, and OpenRouter when that is unset too.
   */
  endpoint?: string;
  /** Model ids by tier, for a provider that names them differently. FANFOLD_MODEL_STEP, _PLAN and _VISION fill the gaps. */
  models?: Partial<Record<Tier, string>>;
  /** Called for every completion, successful or not. */
  onUsage?: (event: UsageEvent) => void;
  maxRetries?: number;
  timeoutMs?: number;
  /** A second answer-tier model, tried once when the first is busy or broken. FANFOLD_MODEL_ANSWER_FALLBACK otherwise. */
  answerFallback?: string | null;
}

/** What a running client can be switched to: another key, endpoint, models and fallback, read as the constructor reads them. */
export type ModelSettings = Pick<ModelClientOptions, 'apiKey' | 'endpoint' | 'models' | 'answerFallback'> & {
  /** Who answers and what to do when it refuses the key, for messages a person reads; worked out from the endpoint otherwise. */
  provider?: Provider;
};

export class ModelClient {
  #apiKey: string;
  #endpoint: string;
  #models: Partial<Record<Tier, string>>;
  #onUsage?: (event: UsageEvent) => void;
  #maxRetries: number;
  #timeoutMs: number;
  #usage: UsageEvent[] = [];
  /** The provider's last refusal of the key or the account, until a call goes through. */
  #refusal: { message: string; at: string } | null = null;
  #answerFallback: string | null = null;
  #named: Provider | null = null;

  constructor(opts: ModelClientOptions) {
    // An empty key is allowed: a host that brings its own model never calls
    // this one. The first call is where it is refused.
    this.#apiKey = '';
    this.#endpoint = '';
    this.#models = {};
    this.use(opts);
    this.#onUsage = opts.onUsage;
    this.#maxRetries = opts.maxRetries ?? 3;
    this.#timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /**
   * Call with this key, endpoint and models from now on, as when the person
   * saves or removes their own key: no restart, and the old key's refusal is
   * forgotten. A call already on its way finishes with what it started with.
   */
  use(settings: ModelSettings): void {
    this.#apiKey = settings.apiKey;
    this.#endpoint = settings.endpoint ? chatCompletionsUrl(settings.endpoint) : modelEndpointFromEnv();
    this.#models = { ...modelIdsFromEnv(), ...settings.models };
    this.#answerFallback = settings.answerFallback !== undefined ? settings.answerFallback : answerFallbackFromEnv();
    this.#named = settings.provider ?? null;
    this.#refusal = null;
  }

  /** The answer tier's second model, or null when none is set. */
  get answerFallback(): string | null {
    return this.#answerFallback;
  }

  /** Whether a call can be attempted at all. A provider of the user's own choosing may need no key. */
  get configured(): boolean {
    return this.#apiKey.trim().length > 0 || !this.#openRouter;
  }

  get endpoint(): string {
    return this.#endpoint;
  }

  get #openRouter(): boolean {
    return this.#endpoint === OPENROUTER_ENDPOINT;
  }

  /** Who answers, and which setting holds its key, for messages a person reads. */
  get #provider(): Provider {
    if (this.#named) return this.#named;
    if (this.#openRouter) return OPENROUTER;
    let name = this.#endpoint;
    try { name = new URL(this.#endpoint).host; } catch { /* the URL as given */ }
    return { name, keyVar: 'FANFOLD_MODEL_KEY', creditAt: 'your provider' };
  }

  /** Why the provider is turning this key away, if it is. A key that is set is not one that works. */
  get refusal(): { message: string; at: string } | null {
    return this.#refusal;
  }

  get usage(): readonly UsageEvent[] {
    return this.#usage;
  }

  totalCostUsd(): number {
    return this.#usage.reduce((sum, e) => sum + effectiveCost(e), 0);
  }

  /** Calls whose cost is not known: the provider reported none and the price book has no price for the model that answered. */
  get unpricedCalls(): number {
    return this.#usage.filter(unpriced).length;
  }

  async complete(opts: CompleteOptions): Promise<Completion<string>> {
    if (!this.configured) {
      throw new Error('no model is configured. Add a Gemini key in Fanfold\'s Settings, under Model. '
        + 'Another agent can still drive Fanfold over MCP without one.');
    }
    const tier: Tier = opts.tier ?? 'step';
    const model = MODELS[tier];
    const modelId = opts.model ?? this.#models[tier] ?? model.id;

    const body: Record<string, unknown> = {
      model: modelId,
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0,
    };

    // `usage` and `reasoning` are OpenRouter's own fields. An OpenAI-compatible
    // endpoint is sent only the standard ones, since some reject the rest outright.
    if (this.#openRouter) {
      body.usage = { include: true };
      const effort = opts.reasoning ?? (model.reasonsByDefault ? 'none' : undefined);
      if (effort === 'none') body.reasoning = { enabled: false };
      else if (effort) body.reasoning = { effort };
    }

    if (opts.schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: opts.schema.name, strict: true, schema: opts.schema.schema },
      };
    }

    const started = Date.now();
    // An answer-tier call is made while a form waits, through the answer limiter with its own deadline: it is never retried.
    // The built-in agent's step and plan calls keep the client's patience.
    const response = await this.#post(body, opts.signal, opts.retries ?? (tier === 'answer' ? 0 : undefined));
    const latencyMs = Date.now() - started;

    const choice = response.choices?.[0];
    const content = choice?.message?.content ?? '';
    const u = response.usage ?? {};
    const promptTokens = Number(u.prompt_tokens ?? 0);
    const completionTokens = Number(u.completion_tokens ?? 0);

    const reportedCostUsd = typeof u.cost === 'number' ? u.cost : null;
    const computed = computeCost(tier, promptTokens, completionTokens, modelId);
    const event: UsageEvent = {
      tier,
      modelId,
      promptTokens,
      completionTokens,
      cachedTokens: Number(u.prompt_tokens_details?.cached_tokens ?? 0),
      reasoningTokens: Number(u.completion_tokens_details?.reasoning_tokens ?? 0),
      reportedCostUsd,
      computedCostUsd: computed ?? 0,
      priceBookVersion: computed === null && reportedCostUsd === null ? PRICE_BOOK_VERSION + UNPRICED : PRICE_BOOK_VERSION,
      latencyMs,
      at: new Date().toISOString(),
    };
    this.#usage.push(event);
    this.#onUsage?.(event);

    if (choice?.finish_reason === 'length') {
      // Cut off mid-reply, so a JSON answer is never whole. Retrying the same
      // budget only buys the same half an answer.
      throw new ModelError(
        `${modelId} reached its ${body.max_tokens}-token limit before finishing its reply ` +
          `(${completionTokens} completion tokens). Raise maxTokens for this call.`,
        null,
        false,
      );
    }
    if (!content) {
      // Almost always a token budget consumed entirely by reasoning.
      throw new ModelError(
        `${modelId} returned no content ` +
          `(${event.reasoningTokens} reasoning tokens of ${completionTokens} completion). ` +
          'Raise maxTokens or lower the reasoning effort.',
        null,
        false,
      );
    }

    return { content, usage: event, raw: content };
  }

  /** Complete and parse against a schema. Throws if the reply is not valid JSON. */
  async completeJson<T>(opts: CompleteOptions & { schema: NonNullable<CompleteOptions['schema']> }): Promise<Completion<T>> {
    const result = await this.complete(opts);
    const text = stripCodeFence(result.content);
    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch (err) {
      throw new ModelError(
        `${opts.schema.name}: model did not return valid JSON (${(err as Error).message}): ${text.slice(0, 200)}`,
        null,
        true,
      );
    }
    return { content: parsed, usage: result.usage, raw: result.content };
  }

  async #post(body: Record<string, unknown>, signal?: AbortSignal, retries = this.#maxRetries): Promise<ApiResponse> {
    let lastError: ModelError | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let res: Response;
      try {
        res = await fetch(this.#endpoint, {
          method: 'POST',
          headers: {
            ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
            'Content-Type': 'application/json',
            ...(this.#openRouter ? { 'HTTP-Referer': 'https://github.com/rishavnaskar/fanfold', 'X-Title': 'Fanfold' } : {}),
          },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        // "fetch failed" alone does not say which address or why.
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        const why = cause?.code ?? cause?.message;
        lastError = new ModelError(
          `network error reaching ${this.#provider.name}: ${(err as Error).message}${why ? ` (${why})` : ''}`, null, true,
        );
        await backoff(attempt);
        continue;
      }

      // Reading the body has to be inside the retry, not after it. A
      // connection that dies partway through the response throws here, not at
      // fetch; outside the retry it would escape as a bare "terminated" that
      // ends the whole run — on the longest prompts, which are the ones worth retrying.
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = new ModelError(`response was cut short: ${(err as Error).message}`, null, true);
        await backoff(attempt);
        continue;
      }

      if (!res.ok) {
        // 429 and 5xx are worth retrying; 4xx means the request itself is wrong.
        const retryable = res.status === 429 || res.status >= 500;
        const wait = waitAsked(res.headers.get('retry-after'), text);
        lastError = new ModelError(describeRefusal(res.status, text, this.#provider), res.status, retryable, wait);
        if (res.status === 402 || refusedKey(res.status, text)) this.#refusal = { message: lastError.message, at: new Date().toISOString() };
        if (!retryable || attempt >= retries) throw lastError;
        await backoff(attempt, wait !== null ? String(wait / 1000) : null);
        continue;
      }

      this.#refusal = null;
      let parsed: ApiResponse;
      try {
        parsed = JSON.parse(text) as ApiResponse;
      } catch {
        lastError = new ModelError(`unparseable response: ${text.slice(0, 200)}`, res.status, true);
        await backoff(attempt);
        continue;
      }

      if (parsed.error) {
        const retryable = /rate|overload|timeout|unavailable/i.test(parsed.error.message ?? '');
        lastError = new ModelError(`provider error: ${parsed.error.message}`, null, retryable);
        if (!retryable) throw lastError;
        await backoff(attempt);
        continue;
      }

      return parsed;
    }

    throw lastError ?? new ModelError('exhausted retries with no error recorded', null, false);
  }
}

interface ApiResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string };
}

export interface Provider {
  name: string;
  keyVar: string;
  creditAt: string;
  /** What to do about a refused key, when it is not editing .env. */
  fix?: string;
}

const OPENROUTER: Provider = { name: 'OpenRouter', keyVar: 'OPENROUTER_API_KEY', creditAt: 'openrouter.ai' };

/**
 * What went wrong, in words a person can act on. A refused key and an empty
 * balance are the two failures only the user can fix, so they say what to do.
 */
export function describeRefusal(status: number, body: string, provider: Provider = OPENROUTER): string {
  const said = providerSaid(body);
  if (refusedKey(status, body)) {
    return `the model key was refused (${provider.name} says: ${said}). ${provider.fix ?? `Check ${provider.keyVar} in .env, then restart Fanfold.`} `
      + 'Another agent can still drive Fanfold over MCP without it.';
  }
  if (status === 402) {
    return `the model account is out of credit (${provider.name} says: ${said}). Add credit at ${provider.creditAt}, then try again.`;
  }
  return `HTTP ${status}: ${said}`;
}

/** The key itself was turned away. Google says so with a 400 that names the key, not a 401. */
function refusedKey(status: number, body: string): boolean {
  return status === 401 || status === 403 || (status === 400 && /API[_ ]key (?:not valid|expired)|API_KEY_INVALID/i.test(body));
}

/**
 * What the provider said, as words: the message inside its error body, which
 * may be an object or a list of them (Google's is), never the JSON itself.
 */
export function providerSaid(body: string): string {
  const text = body.trim();
  try {
    const parsed = JSON.parse(text) as unknown;
    const first = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: { message?: unknown; status?: unknown } | string; message?: unknown } | undefined;
    const message = typeof first?.error === 'string' ? first.error : first?.error?.message ?? first?.message;
    if (typeof message === 'string' && message.trim()) return message.replace(/\s+/g, ' ').trim().slice(0, 300);
    const status = typeof first?.error === 'object' ? first.error?.status : undefined;
    if (typeof status === 'string') return status.toLowerCase().replace(/_/g, ' ');
  } catch { /* not JSON: the words stand as they are */ }
  return /^[[{]/.test(text) ? 'no reason given' : text.replace(/\s+/g, ' ').slice(0, 300);
}

/** How long the provider asked to wait: its Retry-After header, or the delay its error names ("retry in 59.2s", "retryDelay": "59s"). */
export function waitAsked(header: string | null | undefined, body: string): number | null {
  const fromHeader = header ? Number(header) : NaN;
  if (Number.isFinite(fromHeader) && fromHeader > 0) return Math.round(fromHeader * 1000);
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body) ?? /\bretry (?:in|after) (\d+(?:\.\d+)?)\s*(?:s|sec|seconds)\b/i.exec(body);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/** The answer tier's second model, tried once when the first is busy or broken. */
export function answerFallbackFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.FANFOLD_MODEL_ANSWER_FALLBACK?.trim() || null;
}

function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
  const fromHeader = retryAfter ? Number(retryAfter) * 1000 : NaN;
  // Jitter here is for retry contention — spreading concurrent clients so they
  // do not resynchronise on the next attempt. It is not, and must not become,
  // a way to look human to a server.
  const base = Number.isFinite(fromHeader) ? fromHeader : Math.min(500 * 2 ** attempt, 8_000);
  return new Promise((resolve) => setTimeout(resolve, base + Math.random() * 250));
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

/** A base like http://127.0.0.1:4340/v1 gains the chat-completions path; a full URL is kept. */
export function chatCompletionsUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

/** FANFOLD_MODEL_URL as a chat-completions URL, or OpenRouter's when it is unset. */
export function modelEndpointFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.FANFOLD_MODEL_URL?.trim();
  return url ? chatCompletionsUrl(url) : OPENROUTER_ENDPOINT;
}

export function modelIdsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<Tier, string>> {
  const ids: Partial<Record<Tier, string>> = {};
  for (const tier of Object.keys(MODELS)) {
    const id = env[`FANFOLD_MODEL_${tier.toUpperCase()}`]?.trim();
    if (id) ids[tier] = id;
  }
  return ids;
}

/**
 * The key for whichever endpoint is configured, or '' when there is none.
 * An endpoint of the user's own gets FANFOLD_MODEL_KEY and never the
 * OpenRouter key, which is not theirs to receive.
 */
export function modelKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.FANFOLD_MODEL_URL?.trim() ? env.FANFOLD_MODEL_KEY : env.OPENROUTER_API_KEY)?.trim() ?? '';
}

/** Read the key from the environment, with a clear error when no model can be reached. */
export function apiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const key = modelKeyFromEnv(env);
  if (!key && !env.FANFOLD_MODEL_URL?.trim()) {
    throw new Error('OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your OpenRouter key, '
      + 'or point FANFOLD_MODEL_URL at another OpenAI-compatible endpoint.');
  }
  return key;
}
