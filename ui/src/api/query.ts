import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError } from './client';

/*
 * A small keyed cache. Each key holds the last data and error; components subscribe
 * with useQuery and get refetches when the key is invalidated. No retries, no polling.
 */

export type QueryStatus = 'idle' | 'loading' | 'success' | 'error';

interface Entry<T = unknown> {
  status: QueryStatus;
  data?: T;
  error?: ApiError;
  fetching: boolean;
  stale: boolean;
  at: number;
}

const cache = new Map<string, Entry>();
const fetchers = new Map<string, () => Promise<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Map<string, Set<() => void>>();
const EMPTY: Entry = { status: 'idle', fetching: false, stale: true, at: 0 };

function emit(key: string) {
  listeners.get(key)?.forEach((l) => l());
}

function write(key: string, patch: Partial<Entry>) {
  const prev = cache.get(key) ?? EMPTY;
  cache.set(key, { ...prev, ...patch });
  emit(key);
}

function toApiError(e: unknown, key: string): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError(0, e instanceof Error ? e.message : String(e), key);
}

export function fetchQuery<T>(key: string, fetcher?: () => Promise<T>): Promise<T> {
  const fn = (fetcher ?? fetchers.get(key)) as (() => Promise<T>) | undefined;
  if (!fn) return Promise.reject(new Error(`No fetcher for ${key}`));
  if (fetcher) fetchers.set(key, fetcher);
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const prev = cache.get(key) ?? EMPTY;
  write(key, { fetching: true, status: prev.data === undefined ? 'loading' : prev.status });
  const p = fn()
    .then((data) => {
      write(key, { data, error: undefined, status: 'success', fetching: false, stale: false, at: Date.now() });
      return data;
    })
    .catch((e: unknown) => {
      const error = toApiError(e, key);
      write(key, { error, status: 'error', fetching: false, stale: false, at: Date.now() });
      throw error;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function getQueryData<T>(key: string): T | undefined {
  return cache.get(key)?.data as T | undefined;
}

export function setQueryData<T>(key: string, data: T | ((prev: T | undefined) => T)) {
  const prev = cache.get(key)?.data as T | undefined;
  const next = typeof data === 'function' ? (data as (p: T | undefined) => T)(prev) : data;
  write(key, { data: next, error: undefined, status: 'success', stale: false, at: Date.now() });
}

/**
 * Marks keys stale and refetches the ones on screen. A key ending in "*" matches a prefix.
 * Call with no arguments to invalidate everything.
 */
export function invalidate(...keys: string[]) {
  const all = [...new Set([...cache.keys(), ...fetchers.keys()])];
  const match = keys.length
    ? all.filter((k) => keys.some((q) => (q.endsWith('*') ? k.startsWith(q.slice(0, -1)) : k === q)))
    : all;
  for (const k of match) {
    const watched = (listeners.get(k)?.size ?? 0) > 0;
    if (cache.has(k)) write(k, { stale: true });
    if (watched && fetchers.has(k)) fetchQuery(k).catch(() => undefined);
  }
}

/** Drops every cached value; used after a reset. */
export function clearCache() {
  const keys = [...cache.keys()];
  cache.clear();
  keys.forEach((k) => {
    emit(k);
    if ((listeners.get(k)?.size ?? 0) > 0 && fetchers.has(k)) fetchQuery(k).catch(() => undefined);
  });
}

export interface QueryResult<T> {
  data: T | undefined;
  error: ApiError | undefined;
  status: QueryStatus;
  /** True only while there is no data yet. */
  loading: boolean;
  /** True on any request, including background refreshes. */
  fetching: boolean;
  refetch: () => Promise<T>;
}

export function useQuery<T>(key: string, fetcher: () => Promise<T>, opts: { enabled?: boolean } = {}): QueryResult<T> {
  const enabled = opts.enabled ?? true;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  fetchers.set(key, () => fetcherRef.current());

  const subscribe = useCallback(
    (l: () => void) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(l);
      return () => {
        set.delete(l);
      };
    },
    [key],
  );
  const entry = useSyncExternalStore(subscribe, () => (cache.get(key) as Entry<T> | undefined) ?? (EMPTY as Entry<T>));

  useEffect(() => {
    if (!enabled) return;
    const e = cache.get(key);
    if (!e || e.stale) fetchQuery(key).catch(() => undefined);
  }, [key, enabled, entry.stale]);

  const refetch = useCallback(() => fetchQuery<T>(key), [key]);

  return {
    data: entry.data,
    error: entry.error,
    status: entry.status,
    loading: enabled && entry.data === undefined && entry.status !== 'error',
    fetching: entry.fetching,
    refetch,
  };
}

export interface MutationResult<A extends unknown[], R> {
  run: (...args: A) => Promise<R>;
  pending: boolean;
  error: ApiError | undefined;
  reset: () => void;
}

export function useMutation<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  opts: { onSuccess?: (result: R, ...args: A) => void; invalidates?: string[] } = {},
): MutationResult<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (...args: A) => {
    setPending(true);
    setError(undefined);
    try {
      const result = await fnRef.current(...args);
      optsRef.current.onSuccess?.(result, ...args);
      if (optsRef.current.invalidates?.length) invalidate(...optsRef.current.invalidates);
      return result;
    } catch (e) {
      const err = toApiError(e, 'mutation');
      if (mounted.current) setError(err);
      throw err;
    } finally {
      if (mounted.current) setPending(false);
    }
  }, []);

  const reset = useCallback(() => setError(undefined), []);
  return { run, pending, error, reset };
}
