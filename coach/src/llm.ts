import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './store.ts';
import { emit } from './trace.ts';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

export interface JsonOpts {
  task: string;
  system: string;
  prompt: string;
  schema: object;
  tier?: 'fast' | 'smart';
  pdfBase64?: string;
  filename?: string;
}

export class LlmError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Reads KEY=VALUE lines from the repo .env (and the cwd one) without overriding real env vars.
export function loadEnv(): void {
  const files = [resolve('.env'), fileURLToPath(new URL('../../.env', import.meta.url))];
  for (const file of new Set(files)) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      process.env[m[1]] = v;
    }
  }
}
loadEnv();

function cfg() {
  const fast = process.env.TACK_MODEL_FAST || DEFAULT_MODEL;
  return {
    url: process.env.TACK_MODEL_URL || GEMINI_URL,
    key: process.env.TACK_MODEL_KEY || process.env.GEMINI_API_KEY || '',
    fast,
    smart: process.env.TACK_MODEL_SMART || fast,
    rpm: Number(process.env.TACK_MODEL_RPM) || 12,
    retries: Number(process.env.TACK_MODEL_RETRIES ?? 4),
    backoffMs: Number(process.env.TACK_MODEL_BACKOFF_MS ?? 2000),
    timeoutMs: Number(process.env.TACK_MODEL_TIMEOUT_MS ?? 90_000),
    cache: process.env.TACK_LLM_CACHE !== 'off',
  };
}

export function configured(): boolean {
  return Boolean(cfg().key);
}

export function modelName(): string {
  const c = cfg();
  return c.fast === c.smart ? c.fast : `${c.fast} / ${c.smart}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Sliding one-minute window shared by every call in the process.
const stamps: number[] = [];
let queue: Promise<void> = Promise.resolve();
function slot(): Promise<void> {
  const next = queue.then(async () => {
    for (;;) {
      const now = Date.now();
      while (stamps.length && now - stamps[0] >= 60_000) stamps.shift();
      if (stamps.length < cfg().rpm) { stamps.push(now); return; }
      await sleep(60_000 - (now - stamps[0]) + 50);
    }
  });
  queue = next.catch(() => {});
  return next;
}

function cacheDir(): string {
  return join(stateDir(), 'llm-cache');
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function retryDelay(res: Response, body: string, attempt: number, base: number): number {
  const header = Number(res.headers.get('retry-after'));
  if (header > 0) return header * 1000;
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m) return Math.ceil(Number(m[1]) * 1000) + 250;
  return base * 2 ** attempt + Math.floor(Math.random() * base * 0.25);
}

type Part = { type: 'text'; text: string } | { type: 'file'; file: { filename: string; file_data: string } } | { type: 'image_url'; image_url: { url: string } };
type Message = { role: 'system' | 'user' | 'assistant'; content: string | Part[] };

async function post(body: object): Promise<string> {
  const c = cfg();
  for (let attempt = 0; ; attempt++) {
    await slot();
    let res: Response;
    try {
      res = await fetch(c.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${c.key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(c.timeoutMs),
      });
    } catch (err) {
      if (attempt < c.retries) { await sleep(c.backoffMs * 2 ** attempt); continue; }
      throw new LlmError(0, `model endpoint unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (res.ok) {
      let data: any;
      try { data = JSON.parse(text); } catch { throw new LlmError(502, 'model endpoint returned non-JSON'); }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map((p: any) => p?.text ?? '').join('');
      throw new LlmError(502, `model returned no content (finish: ${data?.choices?.[0]?.finish_reason ?? 'unknown'})`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < c.retries) {
      await sleep(retryDelay(res, text, attempt, c.backoffMs));
      continue;
    }
    throw new LlmError(res.status, `model call failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

function pdfParts(prompt: string, pdfBase64: string, filename: string, style: 'file' | 'image_url'): Part[] {
  const url = `data:application/pdf;base64,${pdfBase64}`;
  const doc: Part = style === 'file'
    ? { type: 'file', file: { filename, file_data: url } }
    : { type: 'image_url', image_url: { url } };
  return [{ type: 'text', text: prompt }, doc];
}

function formatName(task: string): string {
  return task.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'result';
}

async function complete(messages: Message[], schema: object, model: string, task: string): Promise<string> {
  const body = { model, messages, response_format: { type: 'json_schema', json_schema: { name: formatName(task), schema } } };
  try {
    return await post(body);
  } catch (err) {
    // Some OpenAI-compatible servers reject json_schema; fall back to plain JSON mode with the schema in the prompt.
    if (err instanceof LlmError && err.status === 400 && /response_format|json_schema|schema/i.test(err.message)) {
      const [sys, ...rest] = messages;
      const withSchema: Message = { role: 'system', content: `${sys.content}\n\nReply with JSON only, matching this JSON schema:\n${JSON.stringify(schema)}` };
      return post({ model, messages: [withSchema, ...rest], response_format: { type: 'json_object' } });
    }
    throw err;
  }
}

export async function json<T>(opts: JsonOpts): Promise<T> {
  const c = cfg();
  if (!c.key) throw new LlmError(503, 'no model key configured (set GEMINI_API_KEY or TACK_MODEL_KEY)');
  const model = opts.tier === 'smart' ? c.smart : c.fast;
  const t0 = Date.now();
  const cacheKey = sha(JSON.stringify({
    model, system: opts.system, prompt: opts.prompt, schema: opts.schema,
    pdf: opts.pdfBase64 ? sha(opts.pdfBase64) : null,
  }));
  const file = join(cacheDir(), `${cacheKey}.json`);
  if (c.cache && existsSync(file)) {
    try {
      const hit = JSON.parse(readFileSync(file, 'utf8'));
      emit({ run: 'model', step: opts.task, detail: `${model} cached`, status: 'ok', ms: Date.now() - t0 });
      return hit.value as T;
    } catch { /* unreadable cache entry: fall through and call the model */ }
  }

  const messages: Message[] = [{ role: 'system', content: opts.system }, { role: 'user', content: opts.prompt }];
  try {
    let raw: string;
    if (opts.pdfBase64) {
      const filename = opts.filename || 'resume.pdf';
      try {
        messages[1] = { role: 'user', content: pdfParts(opts.prompt, opts.pdfBase64, filename, 'file') };
        raw = await complete(messages, opts.schema, model, opts.task);
      } catch (err) {
        if (!(err instanceof LlmError) || err.status !== 400) throw err;
        messages[1] = { role: 'user', content: pdfParts(opts.prompt, opts.pdfBase64, filename, 'image_url') };
        raw = await complete(messages, opts.schema, model, opts.task);
      }
    } else {
      raw = await complete(messages, opts.schema, model, opts.task);
    }

    let { value, errors } = parseChecked(raw, opts.schema);
    if (errors.length) {
      // One corrective round trip before giving up.
      const retry: Message[] = [...messages, { role: 'assistant', content: raw }, {
        role: 'user',
        content: `That reply did not match the required JSON schema: ${errors.slice(0, 6).join('; ')}. Reply again with corrected JSON only.`,
      }];
      raw = await complete(retry, opts.schema, model, opts.task);
      ({ value, errors } = parseChecked(raw, opts.schema));
      if (errors.length) throw new LlmError(502, `model output failed schema check: ${errors.slice(0, 3).join('; ')}`);
    }

    if (c.cache) {
      mkdirSync(cacheDir(), { recursive: true });
      writeFileSync(file, JSON.stringify({ task: opts.task, model, at: new Date().toISOString(), value }));
    }
    emit({ run: 'model', step: opts.task, detail: model, status: 'ok', ms: Date.now() - t0 });
    return value as T;
  } catch (err) {
    emit({ run: 'model', step: opts.task, detail: (err as Error).message.slice(0, 200), status: 'fail', ms: Date.now() - t0 });
    throw err;
  }
}

function parseChecked(raw: string, schema: object): { value: unknown; errors: string[] } {
  let value: unknown;
  try {
    value = repairJson(raw);
  } catch (err) {
    return { value: undefined, errors: [(err as Error).message] };
  }
  const errors: string[] = [];
  value = conform(value, schema as Schema, '$', errors);
  return { value, errors };
}

// Parses model output that is almost JSON: code fences, prose around it, trailing commas,
// or a reply cut off mid-object.
export function repairJson(text: string): unknown {
  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { return JSON.parse(s); } catch { /* keep going */ }
  const start = s.search(/[{[]/);
  if (start < 0) throw new Error('no JSON object in model output');
  s = s.slice(start);
  const close = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  const attempts = [close > 0 ? s.slice(0, close + 1) : s, s];
  for (const a of attempts) {
    const cleaned = a.replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(cleaned); } catch { /* next */ }
  }
  for (const candidate of truncationFixes(s)) {
    try { return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1')); } catch { /* next */ }
  }
  throw new Error('model output is not valid JSON');
}

// For a reply cut off mid-stream: cut back to each earlier element boundary and close the open brackets.
function truncationFixes(s: string): string[] {
  const cuts: { at: number; close: string }[] = [];
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  const closers = () => [...stack].reverse().join('');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') { stack.pop(); cuts.push({ at: i + 1, close: closers() }); }
    else if (ch === ',') cuts.push({ at: i, close: closers() });
  }
  // Prefer dropping a half-written element over keeping a partial one.
  const recent = cuts.slice(-60).reverse();
  const whole = recent.filter((c) => s[c.at - 1] === '}' || s[c.at - 1] === ']');
  const commas = recent.filter((c) => s[c.at - 1] !== '}' && s[c.at - 1] !== ']');
  const out = inStr ? [] : [s.replace(/,\s*$/, '') + closers()];
  return out.concat([...whole, ...commas].map((c) => s.slice(0, c.at) + c.close));
}

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
};

// Light JSON-schema check that also coerces the harmless mismatches models make ("4" for 4).
export function conform(value: unknown, schema: Schema, path: string, errors: string[]): unknown {
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const is = (t: string) => types.length === 0 || types.includes(t);
  if (value === null || value === undefined) {
    if (types.includes('null')) return value;
    errors.push(`${path} is missing`);
    return value;
  }
  if (is('object') && typeof value === 'object' && !Array.isArray(value) && (schema.properties || types.includes('object'))) {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in obj) || obj[r] === undefined) errors.push(`${path}.${r} is required`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in obj && obj[k] !== undefined) obj[k] = conform(obj[k], sub, `${path}.${k}`, errors);
    }
    return obj;
  }
  if (is('array') && Array.isArray(value)) {
    return schema.items ? value.map((v, i) => conform(v, schema.items!, `${path}[${i}]`, errors)) : value;
  }
  if ((is('number') || is('integer')) && types.length) {
    let n = value;
    if (typeof n === 'string' && n.trim() !== '' && !Number.isNaN(Number(n))) n = Number(n);
    if (typeof n === 'number' && Number.isFinite(n)) {
      if (types.includes('integer') && !types.includes('number')) n = Math.round(n);
      return checkEnum(n, schema, path, errors);
    }
  }
  if (is('string') && types.length) {
    if (typeof value === 'string') return checkEnum(value, schema, path, errors);
    if (typeof value === 'number' || typeof value === 'boolean') return checkEnum(String(value), schema, path, errors);
  }
  if (is('boolean') && types.length) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'false') return value === 'true';
  }
  if (!types.length) return checkEnum(value, schema, path, errors);
  errors.push(`${path} should be ${types.join(' or ')}`);
  return value;
}

function checkEnum(value: unknown, schema: Schema, path: string, errors: string[]): unknown {
  if (!schema.enum || schema.enum.includes(value)) return value;
  if (typeof value === 'string') {
    const hit = schema.enum.find((e) => typeof e === 'string' && e.toLowerCase() === value.toLowerCase().trim());
    if (hit !== undefined) return hit;
  }
  errors.push(`${path} should be one of ${schema.enum.join(', ')}`);
  return value;
}
