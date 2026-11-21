import { useAppState } from './hooks';
import type { AppState, Capabilities, HostedInfo } from './types';

const ALL: Capabilities = { apply: true, mail: true, autopilot: true, reason: '' };

/** The server's capabilities; a server that does not send them can do everything. */
export function capabilitiesOf(state?: AppState | null): Capabilities {
  return { ...ALL, ...(state?.capabilities ?? {}) };
}

export function useCapabilities(): Capabilities {
  return capabilitiesOf(useAppState().data);
}

/**
 * Whether this server offers a feature; undefined until /api/state has answered, so a screen on
 * the web preview never calls a route that turns it away. If the state cannot be read, assume yes.
 */
export function useCan(feature: 'apply' | 'mail' | 'autopilot'): boolean | undefined {
  const { data, error } = useAppState();
  if (!data) return error ? true : undefined;
  return capabilitiesOf(data)[feature];
}

/** Set only on the hosted web preview. */
export function useHosted(): AppState['hosted'] | null {
  return useAppState().data?.hosted ?? null;
}

export type { Capabilities, HostedInfo };
