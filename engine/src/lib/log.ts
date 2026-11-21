/**
 * Structured logging: one JSON object per line on stderr.
 *
 * No dependency. Each line carries a timestamp, a level, a message and
 * whatever context the caller bound (run, worker, conversation), so a failure
 * can be traced to the run that caused it. Values under keys that look like
 * credentials are redacted before they are written: the agent handles API
 * keys and OAuth tokens, and a log is the easiest place for one to leak.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';
type Threshold = Level | 'silent';

const ORDER: Record<Threshold, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** A logger that adds these fields to every line. */
  child(fields: Fields): Logger;
}

export interface LoggerOptions {
  level?: Threshold;
  /** 'json' for machines, 'pretty' for a person at a terminal. */
  format?: 'json' | 'pretty';
  /** Where lines go. Defaults to stderr. */
  write?: (line: string) => void;
  now?: () => Date;
}

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/i;
const REDACTED = '[redacted]';

/** Make a value safe and serialisable: errors expanded, secrets hidden, cycles cut. */
export function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, ...(value.stack ? { stack: value.stack } : {}) };
  }
  if (typeof value === 'bigint') return value.toString();
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined && v !== '' ? REDACTED : sanitize(v, seen);
  }
  return out;
}

export function createLogger(opts: LoggerOptions = {}, bound: Fields = {}): Logger {
  const threshold = ORDER[opts.level ?? 'info'];
  const format = opts.format ?? 'json';
  const write = opts.write ?? ((line: string) => { process.stderr.write(line + '\n'); });
  const now = opts.now ?? (() => new Date());

  const emit = (level: Level, msg: string, fields?: Fields): void => {
    if (ORDER[level] < threshold) return;
    const ctx = sanitize({ ...bound, ...fields }) as Fields;
    const ts = now().toISOString();
    if (format === 'pretty') {
      const extra = Object.entries(ctx).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
      write(`${ts} ${level.toUpperCase().padEnd(5)} ${msg}${extra ? ' ' + extra : ''}`);
      return;
    }
    write(JSON.stringify({ ts, level, msg, ...ctx }));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(opts, { ...bound, ...fields }),
  };
}

/**
 * The process logger, configured from the environment.
 *
 * FANFOLD_LOG_LEVEL: debug | info | warn | error | silent (default info).
 * FANFOLD_LOG_FORMAT: json | pretty (default pretty at a terminal, else json).
 */
export function loggerFromEnv(env: NodeJS.ProcessEnv = process.env, isTty = Boolean(process.stderr.isTTY)): Logger {
  const raw = (env.FANFOLD_LOG_LEVEL ?? '').trim().toLowerCase();
  const level = (raw in ORDER ? raw : 'info') as Threshold;
  const rawFormat = (env.FANFOLD_LOG_FORMAT ?? '').trim().toLowerCase();
  const format = rawFormat === 'json' || rawFormat === 'pretty' ? rawFormat : isTty ? 'pretty' : 'json';
  return createLogger({ level, format });
}

/** Discards everything. For tests and embedders that log elsewhere. */
export const silentLogger: Logger = createLogger({ level: 'silent' });
