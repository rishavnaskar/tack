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

/** Set only on the hosted web preview. */
export function useHosted(): AppState['hosted'] | null {
  return useAppState().data?.hosted ?? null;
}

export type { Capabilities, HostedInfo };
