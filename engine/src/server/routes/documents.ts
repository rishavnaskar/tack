/**
 * The person's documents: importing one, removing one, and the two ways one
 * becomes something forms may answer from. Only the owner's key reaches /api.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_DOCUMENT_BODY_BYTES, readBody, sendJson } from '../http.ts';
import * as Bodies from '../bodies.ts';
import { extractTextOffThread, importDocument, MAX_DOCUMENT_BYTES } from '../../memory/import.ts';
import { readerText } from '../../memory/document-instructions.ts';
import { notAResume } from '../../jobs/profile-documents.ts';
import type { RouteContext } from './context.ts';

/** What the person reads. */
const COPY = {
  noDocument: 'There is no file with that id.',
  notResume: 'That doesn’t look like a résumé: {title} has no work history and no contact details. Choose your résumé, or add this file on Profile instead.',
  someoneElse: 'The file {title} carries the name {name}, not yours. If it is your résumé anyway, press This is mine anyway.',
};

/** Answer a request if it is one of these routes. False means "not mine". */
export async function handleDocumentRoutes(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/api/documents' && req.method === 'POST') {
    await addDocument(ctx, req, res);
    return true;
  }
  const doc = url.pathname.match(/^\/api\/documents\/([\w-]+)$/);
  if (doc && req.method === 'DELETE') {
    // What was read from it goes with it; a fact another of the user's documents also states stays theirs.
    await ctx.app.removeDocument(doc[1]);
    sendJson(res, { deleted: true });
    return true;
  }
  // "This is mine, use it to answer": what it says about the owner may now go in forms.
  // "This is mine anyway" (`anyway`) for a file that carries somebody else's name; `resume` makes it the résumé too.
  const mine = url.pathname.match(/^\/api\/documents\/([\w-]+)\/mine$/);
  if (mine && req.method === 'POST') {
    const body = await readBody(req, Bodies.DocumentMine);
    const id = mine[1];
    if (body.anyway) {
      if (!ctx.app.mineAnyway(id)) return notFound(res);
    } else {
      if (!ctx.app.memory.trustDocument(id)) return notFound(res);
      ctx.emit({ type: 'document_allowed', id });
      void ctx.app.fillProfileFrom(id);
    }
    const replaced = body.resume ? await makeResume(ctx, id) : null;
    sendJson(res, { trusted: true, ...(body.resume ? { resume: true, replaced } : {}) });
    return true;
  }
  // Only the owner's key reaches here: the agent that imported a file can never allow it.
  const allow = url.pathname.match(/^\/api\/documents\/([\w-]+)\/allow$/);
  if (allow && req.method === 'POST') {
    if (!ctx.app.memory.releaseDocument(allow[1])) {
      sendJson(res, { error: 'no file with that id is waiting for your OK' }, 404);
      return true;
    }
    ctx.emit({ type: 'document_allowed', id: allow[1] });
    // One that names the user is theirs as well as allowed: the page says which.
    await ctx.app.judgeDocument(allow[1]).catch(() => null);
    void ctx.app.fillProfileFrom(allow[1]);
    sendJson(res, { allowed: true, trusted: ctx.app.memory.documentTrusted(allow[1]) });
    return true;
  }
  return false;
}

function notFound(res: ServerResponse): true {
  sendJson(res, { error: COPY.noDocument }, 404);
  return true;
}

/**
 * One résumé at a time: this document is it now, and the one before it is
 * removed, with every worker and waiting application that named it following
 * to this one. The one it replaced, if any.
 */
async function makeResume(ctx: RouteContext, id: string): Promise<{ id: string; title: string } | null> {
  const before = ctx.app.resumeDocument();
  ctx.app.profile.setResume(id);
  const title = ctx.app.memory.listDocuments().find((d) => d.id === id)?.title ?? '';
  if (before && before.id !== id) await ctx.app.removeDocument(before.id, { id, title });
  ctx.emit({ type: 'setup_changed' });
  return before && before.id !== id ? before : null;
}

/**
 * Import one of the user's documents.
 *
 * PDFs are extracted here rather than at retrieval time, and a low-
 * confidence extraction is never indexed: a subset font without a
 * ToUnicode map yields plausible-looking bytes that are not words, and
 * indexing those poisons every later search. Such a PDF, or a scan, is
 * kept as a file with no text, so it can still be attached, and the
 * reply says so with `unreadable`.
 *
 * Imported as the résumé (`resume`), a file with no work history and no
 * contact details is refused as one, and one that carries somebody else's
 * name is kept but is not made the résumé. Otherwise it replaces the résumé
 * before it, and the reply says what was read from this file alone.
 */
async function addDocument(ctx: RouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, Bodies.Document, MAX_DOCUMENT_BODY_BYTES);
  const bytes = body.base64 ? Buffer.from(body.base64, 'base64') : undefined;
  const imported = importDocument(ctx.app.memory, {
    title: body.title ?? '', text: body.text, mime: body.mime, bytes,
    keepUnreadable: true,
    extracted: bytes && bytes.length <= MAX_DOCUMENT_BYTES ? await extractTextOffThread(bytes, body.mime) : undefined,
  });
  if (!imported.ok) {
    return sendJson(res, { error: imported.error, ...(imported.warnings ? { warnings: imported.warnings } : {}) }, imported.status);
  }
  ctx.emit({ type: 'document_added', id: imported.id, title: imported.title });
  // Whose it is, before the reply: the page says so at once when it carries somebody else's name.
  await ctx.app.judgeDocument(imported.id).catch(() => null);
  const otherName = ctx.app.owners.otherName(imported.id);
  const reply = {
    id: imported.id, title: imported.title, characters: imported.characters, warnings: imported.warnings,
    ...(imported.unreadable ? { unreadable: true } : {}),
    ...(imported.existing ? { existing: true } : {}),
    ...(otherName ? { otherName } : {}),
  };
  if (!body.resume || !imported.characters) {
    if (imported.characters) void ctx.app.fillProfileFrom(imported.id);
    return sendJson(res, reply);
  }

  const whole = await ctx.app.memory.documentText(imported.id);
  if (!whole || notAResume(readerText(whole).text)) {
    // Brought in only to be the résumé, and not one: nothing of it is kept. A copy imported before stays as it was.
    if (!imported.existing) await ctx.app.removeDocument(imported.id);
    return sendJson(res, { error: COPY.notResume.replace('{title}', imported.title), notResume: true }, 422);
  }
  if (otherName) {
    void ctx.app.fillProfileFrom(imported.id);
    return sendJson(res, { ...reply, error: COPY.someoneElse.replace('{title}', imported.title).replace('{name}', otherName) }, 409);
  }
  const replaced = await makeResume(ctx, imported.id);
  // What this file alone gave, so the step says what came from the résumé just picked.
  const read = await ctx.app.fillProfileFrom(imported.id);
  sendJson(res, {
    ...reply, resume: true, replaced,
    found: read ? { usable: read.usable.length, proposed: read.proposed.length, model: read.model, problem: read.problem, skipped: read.skipped } : null,
  });
}
