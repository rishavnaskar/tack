/**
 * Where Fanfold's own model comes from: a Gemini key the person saved in
 * Fanfold, else what .env configures, else nothing. The one place that
 * decides it, so the alpha's own-key path can be swapped for paid plans.
 */

import type { SecretStore } from '../connectors/keychain.ts';
import { answerFallbackFromEnv, modelEndpointFromEnv, modelIdsFromEnv, modelKeyFromEnv, providerSaid } from './client.ts';
import type { Tier } from './pricebook.ts';

export type ModelSourceKind = 'yours' | 'env' | 'none';

export interface ModelSource {
  kind: ModelSourceKind;
  apiKey: string;
  endpoint?: string;
  models?: Partial<Record<Tier, string>>;
  answerFallback?: string | null;
  /** Who answers, and what a person whose key is refused should do; worked out from the endpoint when absent. */
  provider?: { name: string; keyVar: string; creditAt: string; fix?: string };
}

/** The name the saved key is kept under, encrypted. */
export const GEMINI_KEY_SECRET = 'model.geminiKey';

/** What the person reads. */
export const COPY = {
  notAKey: 'That is not a whole Gemini key. Copy it again from Google AI Studio and paste it here.',
  refused: 'Google did not accept this key: {reason}',
  unreachable: 'Fanfold could not check the key with Google ({reason}). Nothing was saved; try again in a minute.',
  replaceKey: 'Replace your Gemini key in Settings, under Model.',
};

/** The alpha's settings for a person's own Gemini key. Goes when plans arrive. */
export const ALPHA_GEMINI = {
  endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
  models: { step: 'gemini-3.5-flash-lite', plan: 'gemini-3.5-flash-lite', vision: 'gemini-3.5-flash-lite', answer: 'gemini-3.5-flash-lite' } satisfies Record<Tier, string>,
  answerFallback: 'gemini-3.1-flash-lite',
  keyPage: 'https://aistudio.google.com/apikey',
  provider: { name: 'Google', keyVar: 'the Gemini key', creditAt: 'Google AI Studio', fix: COPY.replaceKey },
};

/** A key as pasted: trimmed, and null when it cannot be one. Alpha only: goes when plans arrive. */
export function cleanKey(raw: string): string | null {
  const key = raw.trim();
  return key.length >= 20 && key.length <= 200 && !/\s/.test(key) ? key : null;
}

/** The key the person saved wins; then what .env configures (`envKey`, when Fanfold was started with one); then none. */
export async function modelSource(deps: { secrets: Pick<SecretStore, 'get'>; env?: NodeJS.ProcessEnv; envKey?: string }): Promise<ModelSource> {
  const saved = (await deps.secrets.get(GEMINI_KEY_SECRET))?.trim();
  // Alpha only: the person's own key goes when plans arrive.
  if (saved) {
    return {
      kind: 'yours', apiKey: saved, endpoint: ALPHA_GEMINI.endpoint, models: { ...ALPHA_GEMINI.models },
      answerFallback: ALPHA_GEMINI.answerFallback, provider: ALPHA_GEMINI.provider,
    };
  }
  const env = deps.env ?? process.env;
  const apiKey = (deps.envKey ?? modelKeyFromEnv(env)).trim();
  // As ModelClient.configured has it: a key, or an endpoint of the user's own that may need none.
  if (!apiKey && !env.FANFOLD_MODEL_URL?.trim()) return { kind: 'none', apiKey: '' };
  return { kind: 'env', apiKey, endpoint: modelEndpointFromEnv(env), models: modelIdsFromEnv(env), answerFallback: answerFallbackFromEnv(env) };
}

export type KeyCheck =
  | { ok: true }
  /** Google turned the key down. */
  | { ok: false; refused: true; error: string }
  /** Google could not be reached, or could not answer just now: the key is neither good nor bad yet. */
  | { ok: false; refused: false; error: string };

/** Whether Google takes this key: one listing of its models, which costs nothing. Alpha only: goes when plans arrive. */
export async function checkGeminiKey(key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<KeyCheck> {
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(`${ALPHA_GEMINI.endpoint}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    const reason = (err as Error).name === 'TimeoutError' ? `no answer within ${Math.round(timeoutMs / 1000)} s` : cause ?? (err as Error).message;
    return { ok: false, refused: false, error: COPY.unreachable.replace('{reason}', reason) };
  }
  if (res.ok) return { ok: true };
  if (res.status === 429 || res.status >= 500) return { ok: false, refused: false, error: COPY.unreachable.replace('{reason}', providerSaid(text)) };
  return { ok: false, refused: true, error: COPY.refused.replace('{reason}', providerSaid(text)) };
}
