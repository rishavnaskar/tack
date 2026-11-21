/**
 * "Your Chrome" as one more way of getting a browser.
 *
 * Returns what launchChrome and connectToChrome return, so the app can hold
 * any of the three the same way. The difference is whose browser it is:
 * closing this one lets go of the user's tabs and leaves Chrome, and by
 * default the Fanfold tab group, exactly where they were.
 */

import { CdpClient, type CdpClientOptions } from '../cdp/client.ts';
import type { SitePolicy } from '../jobs/site-policies.ts';
import type { ExtensionBridge } from './bridge.ts';

export interface ExtensionConnectOptions extends CdpClientOptions {
  /** How long to wait for the extension to be connected. */
  waitMs?: number;
  /**
   * Close the tabs Fanfold opened when this browser is closed. Off by
   * default: the work stays where the user can see it. Tabs the user moved
   * into the group themselves are never closed either way.
   */
  closeTabsOnClose?: boolean;
}

export interface ExtensionBrowser {
  client: CdpClient;
  process: null;
  profileDir: string;
  close(): Promise<void>;
}

export async function connectViaExtension(
  bridge: ExtensionBridge,
  opts: ExtensionConnectOptions = {},
): Promise<ExtensionBrowser> {
  const transport = await bridge.waitForConnection(opts.waitMs ?? 15_000);
  const client = new CdpClient(transport, opts);
  try {
    await client.send('Target.getTargets');
  } catch (err) {
    client.close();
    throw err;
  }

  return {
    client,
    process: null,
    profileDir: '(your Chrome: the profile belongs to the running browser)',
    async close() {
      await transport.release({ closeTabs: opts.closeTabsOnClose ?? false });
      client.close();
    },
  };
}

/**
 * What Fanfold cannot do in the user's Chrome that it does in its own window,
 * said plainly where the person chooses between them.
 */
export const COPY = {
  downloads: 'Downloads go where your Chrome puts them, and Fanfold cannot see them, so it cannot tell you when a file arrives.',
  pushback: 'Fanfold cannot see "too many requests" errors in your Chrome, so it cannot slow down automatically.',
  uploadOff: 'To attach files like your résumé, turn on "Allow access to file URLs" for the Fanfold extension: open chrome://extensions, choose Details on Fanfold, and switch it on.',
  uploadUnknown: 'Attaching files like your résumé may need "Allow access to file URLs" turned on for the Fanfold extension (chrome://extensions, then Details on Fanfold).',
  denied: '{sites} don’t allow automated browser extensions, so work on them stays in Fanfold’s own window.',
  deniedOne: '{sites} doesn’t allow automated browser extensions, so work on it stays in Fanfold’s own window.',
};

/** The gaps, as sentences, for this extension and this catalog. */
export function extensionGaps(
  status: { fileAccess: boolean | null },
  policies: readonly Pick<SitePolicy, 'label' | 'extensionAllowed'>[],
): string[] {
  const denied = policies.filter((p) => !p.extensionAllowed).map((p) => p.label);
  return [
    COPY.downloads,
    COPY.pushback,
    ...(status.fileAccess === true ? [] : [status.fileAccess === false ? COPY.uploadOff : COPY.uploadUnknown]),
    ...(denied.length ? [(denied.length === 1 ? COPY.deniedOne : COPY.denied).replace('{sites}', denied.length > 1 ? denied.slice(0, -1).join(', ') + ' and ' + denied[denied.length - 1] : denied[0])] : []),
  ];
}

/**
 * The hosts the extension must refuse, from the site catalog: every site
 * whose terms rule out automation from a browser extension. Those are worked
 * in Fanfold's own window only.
 */
export function extensionDenyHosts(policies: readonly Pick<SitePolicy, 'hosts' | 'extensionAllowed'>[]): string[] {
  return [...new Set(policies.filter((p) => !p.extensionAllowed).flatMap((p) => p.hosts))];
}
