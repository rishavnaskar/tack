/**
 * The in-page serializer, and the raw shapes it returns before they are
 * turned into an Observation.
 */

import { readFileSync } from 'node:fs';
import type { ActionEvidence, ActionFailure, NodeState } from '../types.ts';

export const SERIALIZER_SOURCE = readFileSync(
  new URL('./page-serializer.js', import.meta.url),
  'utf8',
);

/**
 * Read the version out of the serializer rather than hardcoding it. The two
 * drifting apart would silently disable re-injection: the page would keep an
 * old serializer and we would never notice.
 */
export const SERIALIZER_VERSION = (() => {
  const m = SERIALIZER_SOURCE.match(/const VERSION = (\d+);/);
  if (!m) throw new Error('page-serializer.js has no VERSION constant');
  return Number(m[1]);
})();

interface RawNode {
  ref: string | null;
  role: string;
  name: string | null;
  value: string | null;
  text: string | null;
  depth: number;
  state: NodeState;
  evidence?: ActionEvidence;
  options?: string[];
}

export interface RawObservation {
  stateId: string;
  url: string;
  title: string;
  nodes: RawNode[];
  /** document.readyState when observed. */
  ready?: string;
  walkMs: number;
  truncated: boolean;
  truncationReason?: string | null;
  frames?: number;
  /** The highest ref number handed out so far, so the next document can carry on after it. */
  refHigh?: number;
}

export type ControlKind = 'text' | 'select' | 'checkbox' | 'radio' | 'file' | 'other';

export type ResolveResult =
  | {
    ok: true; role: string; name: string; box: { x: number; y: number; width: number; height: number };
    control: ControlKind;
    /** What a click at the element's centre would land on instead, when something is over it. */
    coveredBy: string | null;
    /** A checkbox or radio drawn at no size: it is clicked through its visible label. */
    viaLabel?: boolean;
  }
  | { ok: false; failure: ActionFailure; detail: string };
