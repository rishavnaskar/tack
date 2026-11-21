/** Where a node sits on the page: the form it belongs to, and what contains it. */
import { unwrapUntrustedForDisplay } from './untrusted.ts';
import type { Observation, ObservedNode } from '../types.ts';

/**
 * Two controls of the same form. Form numbers count per document, so a field
 * in a frame and a button outside it can share one; and a form has a single
 * method, so a GET search box is never the POST application's.
 */
export function sameForm(a: ObservedNode, b: ObservedNode): boolean {
  const x = a.evidence;
  const y = b.evidence;
  if (!x?.inForm || !y?.inForm) return false;
  if ((a.state?.frame ?? '') !== (b.state?.frame ?? '') || (x.formMethod ?? '') !== (y.formMethod ?? '')) return false;
  if (x.formIndex !== undefined && y.formIndex !== undefined && x.formIndex >= 0 && y.formIndex >= 0) return x.formIndex === y.formIndex;
  return x.formActionOrigin === y.formActionOrigin;
}

/** The nodes that contain this one, nearest first, read from the depths of the flat list and never across a seam. */
export function ancestors(observation: Observation, node: ObservedNode): ObservedNode[] {
  const at = observation.nodes.indexOf(node);
  const out: ObservedNode[] = [];
  let depth = node.depth;
  const stop = seamBefore(observation, at);
  for (let i = at - 1; i >= stop && depth > 0; i--) {
    const n = observation.nodes[i];
    if (n.depth < depth) {
      out.push(n);
      depth = n.depth;
    }
  }
  return out;
}

export const nameOf = (node: ObservedNode | undefined): string => (node?.name ? unwrapUntrustedForDisplay(node.name) : '');

/** The first index on this node's side of a merged observation's seam. */
export function seamBefore(observation: Observation, at: number): number {
  const seam = observation.seam;
  return seam !== undefined && at >= seam ? seam : 0;
}

/** The index past the last node on this node's side of the seam. */
export function seamAfter(observation: Observation, at: number): number {
  const seam = observation.seam;
  return seam !== undefined && at < seam ? seam : observation.nodes.length;
}
