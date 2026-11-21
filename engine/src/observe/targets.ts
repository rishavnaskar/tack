import { isFanfoldPage } from '../policy/navigable.ts';
import type { CdpClient } from '../cdp/client.ts';
import { janitorOf } from './janitor.ts';
import type { Owner } from './tab-ledger.ts';

export interface WindowBounds { left: number; top: number; width: number; height: number }

/** A window narrower or shorter than this gets a site's phone layout, or shows too little of a form to follow. */
const MIN_CELL = { width: 900, height: 600 };

/**
 * Where the nth session window goes. On a screen with room, the windows sit
 * side by side in a grid, so the ones working in parallel are all in view;
 * once the grid is full the next lap sits a little down and across from the
 * first. On a screen with room for one, they step down and across from the
 * window that was already there.
 */
export function windowPlace(
  n: number, screen: { left: number; top: number; width: number; height: number } | null, from: WindowBounds,
): WindowBounds {
  const cols = screen ? Math.min(3, Math.floor(screen.width / MIN_CELL.width)) : 1;
  const rows = screen ? Math.min(2, Math.floor(screen.height / MIN_CELL.height)) : 1;
  if (!screen || cols * rows < 2) {
    const step = 1 + n % 8;
    return { left: from.left + 36 * step, top: from.top + 36 * step, width: from.width, height: from.height };
  }
  const slot = n % (cols * rows), lap = Math.floor(n / (cols * rows)) % 4;
  const width = Math.floor(screen.width / cols), height = Math.floor(screen.height / rows);
  return {
    left: screen.left + (slot % cols) * width + 28 * lap, top: screen.top + Math.floor(slot / cols) * height + 28 * lap,
    width: width - 28 * lap, height: height - 28 * lap,
  };
}

/**
 * With `owner`, and a janitor looking after this browser (janitor.ts), the
 * tab is claimed for that owner the moment it exists, so no sweep ever finds
 * it unowned and nothing outlives the work it was opened for.
 */
export async function createTargetWithRetry(client: CdpClient, opts: { window?: WindowBounds | true; owner?: Owner | null } = {}): Promise<string> {
  const janitor = opts.owner ? janitorOf(client) : null;
  if (!janitor || !opts.owner) return createTarget(client, opts, null);
  const owner = opts.owner;
  return janitor.creating(async () => {
    const targetId = await createTarget(client, opts, (id) => !janitor.ledger.get(id));
    janitor.claim(targetId, owner);
    return targetId;
  });
}

/**
 * Open a tab, retrying once on the transient refusal.
 *
 * Chrome can decline `Target.createTarget` with "Failed to open a new tab" on
 * a browser that is otherwise fine — under memory pressure, or while it is
 * still finishing startup. Between attempts we re-check for an existing page,
 * because the tab Chrome was busy opening often arrives during the wait and
 * opening a second one on top of it is worse than waiting. Both failures are
 * reported, since the second is usually the more informative one.
 */
async function createTarget(client: CdpClient, opts: { window?: WindowBounds | true }, free: ((targetId: string) => boolean) | null): Promise<string> {
  const params = !opts.window ? { url: 'about:blank' }
    : opts.window === true ? { url: 'about:blank', newWindow: true }
      : { url: 'about:blank', newWindow: true, ...opts.window };
  try {
    const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', params);
    return targetId;
  } catch (first) {
    const message = (first as Error).message;
    if (!/failed to open a new tab/i.test(message)) throw first;

    await new Promise((resolve) => setTimeout(resolve, 400));

    const { targetInfos } = await client.send<{
      targetInfos: Array<{ targetId: string; type: string }>;
    }>('Target.getTargets');
    // Never a tab that is already some other work's.
    const appeared = targetInfos.find((t) => t.type === 'page' && (!free || free(t.targetId)));
    if (appeared) return appeared.targetId;

    try {
      const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', params);
      return targetId;
    } catch (second) {
      throw new Error(
        `could not open a page in the browser. First attempt: ${message}. ` +
        `Second attempt: ${(second as Error).message}`,
      );
    }
  }
}

const BROWSER_OWN = /^(chrome|chrome-untrusted|chrome-extension|devtools|edge|brave):/i;

/**
 * A page that belongs to the browser rather than the web: its settings, its
 * "what's new" page, an extension's page. Chrome opens these by itself, and
 * a tab list that offers one to an agent only invites it to wander in.
 * Fanfold's own window counts too: it holds the person's key.
 */
export function isBrowserOwnPage(url: string): boolean {
  return BROWSER_OWN.test(url) || isFanfoldPage(url);
}

/**
 * Which Page holds which tab. Each MCP session works in its own tabs, and one
 * session listing or switching into another's would act on work that is not
 * its own. A session keeps every tab it has worked in, and a popup belongs to
 * whoever holds the tab that opened it: an "Apply on company website" tab is
 * the work of the session that clicked it, even before it switches there.
 * Only a tab nobody's page opened is anyone's to look at.
 */
const holders = new Map<string, object>();

export interface TargetLineage { targetId: string; openerId?: string }

export function claimTarget(targetId: string, holder: object): string {
  holders.set(targetId, holder);
  return targetId;
}

export function ownedElsewhere(targetId: string, holder: object, lineage: readonly TargetLineage[] = []): boolean {
  const seen = new Set<string>();
  let id: string | undefined = targetId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const h = holders.get(id);
    if (h !== undefined) return h !== holder;
    id = lineage.find((t) => t.targetId === id)?.openerId;
  }
  return false;
}

/** Holds the tabs of a page that has closed, and whatever they opened. */
const CLOSED = {};

/**
 * A page closed: the tabs it worked in are let go, and the one it started in
 * stays marked as closed with every tab opened from it, however deep. Chrome
 * forgets a tab's opener once the opener is gone, so `lineage` (the targets
 * as they were just before) is the last chance to tell that family apart: a
 * tab of it left open is then listed to no other session.
 */
export function releaseTargets(holder: object, home?: string, lineage: readonly TargetLineage[] = []): void {
  for (const [id, h] of holders) if (h === holder) holders.delete(id);
  if (home) for (const id of familyOf(home, lineage)) holders.set(id, CLOSED);
}

/** A tab and every tab opened from it, however deep; `may` can leave one out, with what it opened. */
export function familyOf(home: string, lineage: readonly TargetLineage[], may: (targetId: string) => boolean = () => true): Set<string> {
  const family = new Set([home]);
  for (let grew = true; grew;) {
    grew = false;
    for (const t of lineage) {
      if (!family.has(t.targetId) && t.openerId && family.has(t.openerId) && may(t.targetId)) {
        family.add(t.targetId);
        grew = true;
      }
    }
  }
  return family;
}

/**
 * Which of the tabs opened from a page its own actions opened.
 *
 * Chrome says which tab opened which, not whether a click by the page's agent
 * or by the person did it: a person can open a link from the session's tab
 * too. So the tabs in the family are looked at before and after each action
 * the page takes, and one that appears during an action, or within a few
 * seconds of one (a popup a page opens late), is the action's. One that
 * appeared while nothing was being done is the person's, and is never closed
 * for them.
 */
export class OpenedTabs {
  static readonly GRACE_MS = 5_000;
  readonly #seen = new Set<string>();
  readonly #mine = new Set<string>();
  #graceUntil = 0;

  /** The family as it is now; `acting` while one of the page's own actions is under way. */
  note(family: Iterable<string>, acting: boolean, now = Date.now()): void {
    const ours = acting || now <= this.#graceUntil;
    for (const id of family) {
      if (this.#seen.has(id)) continue;
      this.#seen.add(id);
      if (ours) this.#mine.add(id);
    }
  }

  /** An action just ended. */
  acted(now = Date.now()): void {
    this.#graceUntil = now + OpenedTabs.GRACE_MS;
  }

  opened(targetId: string): boolean {
    return this.#mine.has(targetId);
  }
}
