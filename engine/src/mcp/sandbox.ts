/**
 * A sandbox: a separate Chrome on a profile made for the occasion.
 *
 * It has none of the user's cookies, history or sign-ins, and its profile
 * directory is deleted when it closes. For a site nobody has reason to trust
 * with a signed-in browser, or a task that should leave nothing behind.
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { launchChrome } from '../cdp/launcher.ts';
import { Page } from '../observe/page.ts';
import { Janitor } from '../observe/janitor.ts';
import type { Owner, TabLedger } from '../observe/tab-ledger.ts';
import { stateDir } from '../daemon/protocol.ts';
import type { Tab } from '../observe/runtime.ts';

export function sandboxRoot(): string {
  return join(stateDir(), 'sandboxes');
}

/**
 * With a ledger, the sandbox's tab is claimed for `owner` and a janitor
 * closes anything else that appears in it; the whole browser goes when the
 * tab is closed, whatever it opened.
 */
export async function openSandbox(opts: { visible: boolean; owner?: Owner; ledger?: TabLedger }): Promise<Tab> {
  const profileDir = join(sandboxRoot(), randomUUID());
  // A throwaway profile has no use for the desktop keyring, and on a Linux
  // host without one Chrome would otherwise drop its cookies.
  const args = process.platform === 'linux' ? ['--password-store=basic'] : [];
  const owner: Owner = opts.owner ?? { kind: 'sandbox', id: randomUUID() };
  const end = opts.ledger?.begin(owner) ?? null;
  const browser = await launchChrome({ profileDir, headless: !opts.visible, args }).catch((err: unknown) => {
    end?.();
    throw err;
  });
  const janitor = opts.ledger ? new Janitor({ client: browser.client, ledger: opts.ledger, mode: 'sandbox', only: owner }) : null;
  let page: Page;
  try {
    await janitor?.start();
    page = await Page.first(browser.client as never, janitor ? { owner } : {});
  } catch (err) {
    janitor?.stop();
    end?.();
    await browser.close().catch(() => {});
    if (opts.ledger) for (const tab of opts.ledger.ownedBy(owner)) opts.ledger.release(tab.targetId);
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  let closed = false;
  return {
    page,
    ...(janitor ? { owner } : {}),
    close: async () => {
      if (closed) return;
      closed = true;
      janitor?.stop();
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
      end?.();
      // The browser went with every tab in it.
      if (opts.ledger) for (const tab of opts.ledger.ownedBy(owner)) opts.ledger.release(tab.targetId);
      await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
}

/** Profiles left by a process that died before it could clean up. */
export async function removeStaleSandboxes(): Promise<void> {
  await rm(sandboxRoot(), { recursive: true, force: true }).catch(() => {});
}
