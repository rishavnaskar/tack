/**
 * Bringing the owner's own profile in from the sites they are signed in to,
 * and from LinkedIn's export file. Only the owner's key reaches /api, so a
 * reading started here is the owner's own and is trusted at once.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context.ts';
import { HttpError, readJson, sendJson } from '../http.ts';
import { object, parse, string, ValidationError } from '../schema.ts';
import {
  COPY as SITE_COPY, MAX_EXPORT_BYTES, SITE_IDS, importDeps, importLinkedInExport, importSiteProfile, isSiteId, recipes, siteImports,
  type LastImport,
} from '../../jobs/site-profiles.ts';

/** What the owner reads when a route refuses. */
export const COPY = {
  noSite: 'Fanfold does not read profiles from that site.',
  noFile: 'Choose the zip file LinkedIn sent you.',
};

const IMPORT = /^\/api\/profile\/sites\/([\w-]+)\/import$/;
/** base64 inflates by about 4/3, and the JSON around it is small. */
const EXPORT_BODY = Math.ceil(MAX_EXPORT_BYTES * 4 / 3) + 64 * 1024;
const ExportBody = object({ base64: string({ max: EXPORT_BODY }) });

/** Signed in, as far as the last reading could tell: unknown until one is tried. */
function signedIn(last: LastImport | null): 'yes' | 'no' | 'unknown' {
  if (!last) return 'unknown';
  if (last.status === 'signed_out') return 'no';
  return last.status === 'imported' || last.status === 'empty' ? 'yes' : 'unknown';
}

export function sitesView(ctx: RouteContext): Record<string, unknown> {
  const imports = siteImports(ctx.app.db);
  const table = recipes();
  return {
    sites: SITE_IDS.map((id) => {
      const last = imports.last(id);
      return { id, label: table[id].label, start: table[id].start, last, reading: imports.reading(id), signedIn: signedIn(last) };
    }),
    linkedinExport: imports.last('linkedin_export'),
  };
}

export async function handleSiteProfileRoutes(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/api/profile/sites' && req.method === 'GET') {
    sendJson(res, sitesView(ctx));
    return true;
  }
  const site = IMPORT.exec(url.pathname);
  if (site && req.method === 'POST') {
    if (!isSiteId(site[1])) {
      sendJson(res, { error: COPY.noSite }, 404);
      return true;
    }
    if (siteImports(ctx.app.db).reading(site[1])) {
      sendJson(res, { error: SITE_COPY.running.replace('{site}', recipes()[site[1]].label) }, 409);
      return true;
    }
    // It reads for a while in a window of its own; the row that started it hears how it goes through site_import events.
    void importSiteProfile(importDeps(ctx.app), site[1], { startedBy: 'owner' })
      .catch((err: unknown) => ctx.log.warn('a profile reading failed outside its own handling', { err, site: site[1] }));
    sendJson(res, { started: true }, 202);
    return true;
  }
  if (url.pathname === '/api/profile/linkedin-export' && req.method === 'POST') {
    let body: { base64?: string };
    try {
      body = parse(ExportBody, await readJson(req, EXPORT_BODY));
    } catch (err) {
      if (err instanceof HttpError && err.status === 413) {
        sendJson(res, { error: SITE_COPY.exportTooBig }, 413);
        return true;
      }
      if (err instanceof ValidationError) throw new HttpError(400, err.message);
      throw err;
    }
    if (!body.base64) {
      sendJson(res, { error: COPY.noFile }, 400);
      return true;
    }
    const deps = importDeps(ctx.app);
    const result = await importLinkedInExport(deps, Buffer.from(body.base64, 'base64'));
    if (!result.ok) sendJson(res, { error: result.message }, result.status);
    else sendJson(res, { documentId: result.documentId, message: result.message, counts: result.counts });
    return true;
  }
  return false;
}
