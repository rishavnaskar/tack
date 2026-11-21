/** A JSON column read back, or the fallback when it is empty or not JSON. */
export function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}
