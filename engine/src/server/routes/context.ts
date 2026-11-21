import type { App } from '../../app.ts';
import type { Logger } from '../../lib/log.ts';

/** What a route module needs from the server that owns it. */
export interface RouteContext {
  app: App;
  emit(event: { type: string; [k: string]: unknown }): void;
  log: Logger;
}
