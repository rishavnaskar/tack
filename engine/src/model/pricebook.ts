/**
 * Versioned price book.
 *
 * Prices live in data, not in code paths, and every usage event records which
 * version priced it. Model prices change without notice; a ledger that cannot
 * say which prices it used cannot be audited or re-billed, and a hardcoded
 * number silently becomes a lie.
 *
 * Figures below were read from the live OpenRouter models endpoint on
 * 2026-09-15 and each model ID was confirmed with a real completion call.
 * Re-verify with `npm run pricebook:check` rather than trusting this file.
 */

export interface ModelPrice {
  id: string;
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  contextLength: number;
  vision: boolean;
  /** Emits reasoning tokens unless explicitly disabled. */
  reasonsByDefault: boolean;
}

export const PRICE_BOOK_VERSION = '2026-11-17.1';

/** Marks a call whose cost Fanfold could not work out, so a day's spend reads as unknown rather than short. */
export const UNPRICED = ':unpriced';

/**
 * Model tiers.
 *
 * The interesting finding here is that vision is not a premium tier: the
 * cheapest text-only Flash is ~4x cheaper per input token and ~5x cheaper per
 * output token than the vision-capable Flash, while the *planning* model has
 * no vision at all. So the routing rule is not "escalate to vision when
 * stuck" — it is "use the cheap text model for the ~90% of steps that are
 * text, and reach for the vision model precisely when there is an image to
 * look at". Visual perception is cheap; visual *reasoning* is the thing that
 * has to be assembled from a Flash-produced evidence record.
 */
export const MODELS: Record<string, ModelPrice> = {
  // Per-step action selection, extraction, classification. The workhorse.
  step: {
    id: 'deepseek/deepseek-v4-flash-0731',
    inputPerMTok: 0.06,
    outputPerMTok: 0.12,
    contextLength: 1_310_720,
    vision: false,
    // Verified by live call: it emits reasoning tokens unless told not to,
    // and with a tight budget spends every one of them before saying anything.
    reasonsByDefault: true,
  },
  // Only when an image is actually attached.
  vision: {
    id: 'deepseek/deepseek-v4.1-flash',
    inputPerMTok: 0.15,
    outputPerMTok: 0.60,
    contextLength: 1_048_576,
    vision: true,
    reasonsByDefault: true,
  },
  // Planning, recovery after first failure, skill induction, reflection.
  plan: {
    id: 'deepseek/deepseek-v4-pro-0813',
    inputPerMTok: 0.579,
    outputPerMTok: 1.738,
    contextLength: 1_048_576,
    vision: false,
    reasonsByDefault: true,
  },
  // Reading a résumé into a career record, classifying a form's questions,
  // checking an answer against its basis, drafting an essay. Same model as
  // planning until FANFOLD_MODEL_ANSWER says otherwise.
  answer: {
    id: 'deepseek/deepseek-v4-pro-0813',
    inputPerMTok: 0.579,
    outputPerMTok: 1.738,
    contextLength: 1_048_576,
    vision: false,
    reasonsByDefault: true,
  },
};

export type Tier = keyof typeof MODELS;

/** A model's price per 1M tokens from a date on (the first period has none). Null where the provider's list could not be confirmed. */
export interface PricePeriod { from?: string; inputPerMTok: number | null; outputPerMTok: number | null }

/**
 * Models a tier may be pointed at with FANFOLD_MODEL_*, priced by their id.
 * Gemini figures are the paid tier's standard text prices, read from
 * Google's public Gemini API price list on 2026-11-16 (gemini-3.1-flash-lite,
 * the alpha's answer fallback, on 2026-11-17); gemini-3.8-flash
 * doubles on 2027-01-01, as that list says. A model missing from here is
 * priced as unknown, never as whichever model its tier defaults to.
 */
const PRICES_BY_ID: Record<string, PricePeriod[]> = {
  'gemini-3.5-flash-lite': [{ inputPerMTok: 0.30, outputPerMTok: 2.50 }],
  'gemini-3.1-flash-lite': [{ inputPerMTok: 0.25, outputPerMTok: 1.50 }],
  'gemini-3.8-flash': [{ inputPerMTok: 0.75, outputPerMTok: 3.75 }, { from: '2027-01-01', inputPerMTok: 1.50, outputPerMTok: 7.50 }],
};

/** The price of the model that answered, on the day it answered; null when Fanfold does not know it. */
export function priceOf(tier: Tier, modelId: string | undefined, at: Date = new Date()): { inputPerMTok: number; outputPerMTok: number } | null {
  if (!modelId || modelId === MODELS[tier].id) return MODELS[tier];
  const byTier = Object.values(MODELS).find((m) => m.id === modelId);
  if (byTier) return byTier;
  // OpenRouter names a provider first ("google/gemini-3.8-flash"); Google's own API may say "models/gemini-3.8-flash".
  const bare = modelId.trim().toLowerCase().replace(/^(?:google|models)\//, '');
  const day = at.toISOString().slice(0, 10);
  const period = (PRICES_BY_ID[bare] ?? []).filter((p) => !p.from || p.from <= day).at(-1);
  return period && period.inputPerMTok !== null && period.outputPerMTok !== null
    ? { inputPerMTok: period.inputPerMTok, outputPerMTok: period.outputPerMTok } : null;
}

export interface UsageEvent {
  tier: Tier;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  /** Cost the provider reported, when it reports one. Authoritative. */
  reportedCostUsd: number | null;
  /** Cost computed from the price book. Used when the provider reports none. */
  computedCostUsd: number;
  priceBookVersion: string;
  latencyMs: number;
  at: string;
}

/** What a call cost by the price book: by the model that answered when it is not the tier's own; null when that model's price is unknown. */
export function computeCost(tier: Tier, promptTokens: number, completionTokens: number, modelId?: string, at?: Date): number | null {
  const m = priceOf(tier, modelId, at);
  return m ? (promptTokens * m.inputPerMTok + completionTokens * m.outputPerMTok) / 1_000_000 : null;
}

/** A call neither the provider nor the price book could put a cost on. */
export function unpriced(event: Pick<UsageEvent, 'reportedCostUsd' | 'priceBookVersion'>): boolean {
  return event.reportedCostUsd === null && event.priceBookVersion.endsWith(UNPRICED);
}

/** What we bill against: the provider's figure when present, ours otherwise. */
export function effectiveCost(event: UsageEvent): number {
  return event.reportedCostUsd ?? event.computedCostUsd;
}
