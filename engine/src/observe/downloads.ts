/**
 * Sending downloads somewhere known, and noticing when they happen.
 *
 * Default behaviour is worse than it sounds: a download either lands in
 * whatever directory Chrome feels like, or is silently refused, and either way
 * the click looks like it did nothing. Pointing them at one directory under
 * the agent's own state makes them findable, and the events make them
 * reportable.
 *
 * `Browser.setDownloadBehavior` is admitted to the CDP allow-list by name
 * rather than by opening the whole Browser domain; see ALLOWED_METHODS.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { markUntrusted } from '../policy/untrusted.ts';
import type { CdpClient } from '../cdp/client.ts';
import type { DownloadEvent } from '../types.ts';

type DownloadClient = Pick<CdpClient, 'send' | 'on'>;

export class DownloadTracker {
  /** Downloads not yet reported, plus any still in progress. */
  #pending: DownloadEvent[] = [];
  /** Every download seen, by Chrome's guid, so progress can find its own. */
  #seen = new Map<string, DownloadEvent>();
  #dir: string | null = null;
  #wired = false;
  readonly #offs: Array<() => unknown> = [];

  /**
   * Turn download handling on, once per client. The listeners are on the
   * client rather than a session, so attaching them again on every tab switch
   * would count each download twice.
   */
  async enable(client: DownloadClient, dir: string, mine: (frameId: string) => boolean = () => true): Promise<void> {
    if (this.#wired) return;
    this.#wired = true;
    try {
      mkdirSync(dir, { recursive: true });
      await client.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true });
      this.#dir = dir;
    } catch {
      // An older Chrome, or a build without it. Downloads then behave as they
      // did before: the agent simply cannot report them.
      this.#dir = null;
      return;
    }

    // Chrome says where each download began for the whole browser: only those begun in this page's frames are its to report.
    this.#offs.push(client.on('Browser.downloadWillBegin', (params) => {
      const guid = String(params.guid ?? '');
      if (!guid || this.#seen.has(guid) || (params.frameId && !mine(String(params.frameId)))) return;
      const event: DownloadEvent = {
        suggestedFilename: markUntrusted(String(params.suggestedFilename ?? '')),
        url: String(params.url ?? ''),
        state: 'started',
        at: new Date().toISOString(),
      };
      this.#seen.set(guid, event);
      this.#pending.push(event);
    }));

    this.#offs.push(client.on('Browser.downloadProgress', (params) => {
      const state = String(params.state ?? '');
      if (state !== 'completed' && state !== 'canceled') return;
      // Matched by guid, not by "the most recent one": several downloads can
      // be in flight, and they do not finish in the order they started.
      const event = this.#seen.get(String(params.guid ?? ''));
      if (!event || event.state !== 'started') return;
      event.state = state === 'completed' ? 'completed' : 'canceled';
      if (state === 'completed') {
        // Chrome reports where it actually wrote the file. Under
        // `allowAndName` the name on disk is the guid, so a page suggesting
        // "../../.zshrc" gets no say in where anything lands.
        const written = params.filePath ? String(params.filePath) : null;
        event.path = written ?? (this.#dir ? join(this.#dir, String(params.guid)) : undefined);
      }
    }));
  }

  /** Stop listening: the page this tracked for is closed. */
  dispose(): void {
    for (const off of this.#offs.splice(0)) off();
  }

  /**
   * What to report in the next observation. A finished download is reported
   * once; one still in progress stays until it finishes.
   */
  drain(): DownloadEvent[] {
    const out = this.#pending;
    this.#pending = out.filter((d) => d.state === 'started');
    return out;
  }
}
