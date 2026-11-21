/** The user's files: résumés, letters and anything else they hand over. */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';
import { extractTextOffThread, importDocument, MAX_DOCUMENT_BYTES } from '../../memory/import.ts';
import { fenceBlock } from '../../policy/untrusted.ts';
import { whoseText } from '../../policy/upload-hold.ts';
import { importHold, namedLikeACv, waitingText } from '../../policy/import-hold.ts';
import { stateDir } from '../../daemon/protocol.ts';
import type { CallContext, Tool } from '../protocol.ts';
import type { FanfoldContext } from '../context.ts';
import { openDialog, waitForReply, type Reply } from '../dialog.ts';

/** What a person would hand to a job application. Not keys, not configuration. */
const DOCUMENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.rtf': 'application/rtf',
};

/** Folders macOS keeps from an app until the person allows it in Files and Folders. */
const PRIVATE_FOLDERS = ['Desktop', 'Documents', 'Downloads'];

/** The most documents a folder's listing names. */
const MAX_LISTED = 30;

export type Importable =
  | { kind: 'file'; bytes: Buffer; mime: string; name: string; folder: string }
  | { kind: 'folder'; path: string; documents: Array<{ name: string; size: number; modified: Date }> };

/** A file to import, or, for a folder, the documents directly inside it so one can be chosen. */
export async function readImportable(given: string): Promise<Importable> {
  const path = given === '~' || given.startsWith('~/') ? join(homedir(), given.slice(1)) : given;
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('give the full path of the file, starting with / or ~/');
  try {
    return await importable(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') throw new Error(notAllowed(path, code));
    throw err;
  }
}

async function importable(path: string): Promise<Importable> {
  const real = await realpath(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EPERM' || err.code === 'EACCES') throw err;
    throw new Error(`no file at ${path}`);
  });
  if (real.split(sep).some((part) => part.startsWith('.') && part.length > 1)) {
    throw new Error('files inside hidden folders are not imported');
  }
  // Fanfold's own folder holds its keys, its database and its browser profile.
  const own = await realpath(stateDir()).catch(() => stateDir());
  if (real === own || real.startsWith(own + sep)) throw new Error('files inside Fanfold\'s own folder are not imported');
  const info = await stat(real);
  if (info.isDirectory()) return { kind: 'folder', path, documents: await documentsIn(real) };
  const mime = DOCUMENT_TYPES[extname(real).toLowerCase()];
  if (!mime) throw new Error(`only ${Object.keys(DOCUMENT_TYPES).join(', ')} files can be imported`);
  if (!info.isFile()) throw new Error(`${path} is not a file`);
  if (info.size > MAX_DOCUMENT_BYTES) throw new Error(`the file is larger than ${MAX_DOCUMENT_BYTES} bytes`);
  return { kind: 'file', bytes: await readFile(real), mime, name: basename(real), folder: dirname(real) };
}

/** Importable documents directly in a folder named like a résumé, CV or cover letter, newest first. Nothing else in a folder is named to an agent. */
async function documentsIn(folder: string): Promise<Array<{ name: string; size: number; modified: Date }>> {
  const names = (await readdir(folder))
    .filter((name) => !name.startsWith('.') && !name.startsWith('~$') && DOCUMENT_TYPES[extname(name).toLowerCase()] && namedLikeACv(name));
  const found = await Promise.all(names.map(async (name) => {
    const info = await stat(join(folder, name)).catch(() => null);
    return info?.isFile() ? { name, size: info.size, modified: info.mtime } : null;
  }));
  return found.filter((d) => d !== null).sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** What the agent tells the user when this computer would not let Fanfold read a path. */
export function notAllowed(path: string, code: string, platform: NodeJS.Platform = process.platform): string {
  const fold = (p: string) => (platform === 'darwin' ? p.toLowerCase() : p);
  const folder = PRIVATE_FOLDERS.find((name) => {
    const dir = fold(join(homedir(), name));
    return fold(path) === dir || fold(path).startsWith(dir + sep);
  });
  if (platform === 'darwin' && (folder || code === 'EPERM')) {
    return `macOS did not let Fanfold read ${folder ? `the user's ${folder} folder (${path})` : path}. `
      + 'Tell the user that the app that started Fanfold (the terminal, editor or desktop app it runs in) needs their permission: '
      + `they can give it in System Settings › Privacy & Security › Files and Folders${folder ? `, by turning on "${folder} Folder" for that app` : ', under that app'}, then ask you to try again. `
      + 'Fanfold cannot give itself this permission.';
  }
  return `this computer's file permissions do not let Fanfold read ${path}. `
    + 'Tell the user, so they can change the permissions or move the file somewhere Fanfold can read it.';
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function when(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** A folder handed to files_add: the résumés, CVs and cover letters in it to choose from, and nothing else. */
function folderListing(found: Extract<Importable, { kind: 'folder' }>): string {
  const only = 'Only files named as a résumé, CV or cover letter are listed from a folder; nothing else in it is named here.';
  if (!found.documents.length) {
    return `${found.path} is a folder, so nothing was imported, and no file directly inside it is named as a résumé, CV or cover letter. `
      + `${only} Folders inside it are not searched. Ask the user for the full path of the file they mean.`;
  }
  const shown = found.documents.slice(0, MAX_LISTED).map((d) =>
    `${JSON.stringify(join(found.path, d.name))}  ${size(d.size)}  modified ${when(d.modified)}`
    + (d.size > MAX_DOCUMENT_BYTES ? '  (too large to import)' : ''));
  const more = found.documents.length - shown.length;
  return `${found.path} is a folder, so nothing was imported. ${only} Those directly inside it, newest first:\n`
    + shown.join('\n')
    + (more ? `\n… and ${more} older ${more === 1 ? 'one' : 'ones'} named like these, not shown.` : '')
    + '\nCall files_add again with the path of the one the user means. If it is not clear which, ask the user.';
}

const MAX_READ = 40_000;

/** What the agent is told about a file kept without its text: only the owner can give Fanfold one. */
const UNREADABLE = 'its text could not be read, so it is kept only as a file: browser_upload can attach it, '
  + 'but files_search and files_read find nothing in it. Do not guess what it says; ask the user for anything you need from it';

/** Why files_add will not take a file whose text cannot be read. */
const UNREADABLE_REFUSED = 'its text could not be read (it is probably a scan, or encrypted), so nothing can tell what it is, '
  + 'and an agent cannot import it. Nothing was imported. If it is the file the user means, ask them to add it themselves '
  + 'under Documents on the Profile page of Fanfold\'s own window; it will then appear in files_list';

/** What files_list says about a file an outside agent imported. */
const AGENT_IMPORTED = 'an agent imported it, not the user: it can be read, and attaching it waits for the user\'s approval unless it names them';

/** What files_list says about a file waiting for the user's OK. */
const HELD = 'an agent imported it and it is waiting for the user\'s OK in Fanfold: it cannot be read, searched or attached until they allow it';

/** What the agent is told when an import waits for the user's OK, and why. */
function heldReply(title: string, id: string, why: string, notes: string): string {
  return `imported ${JSON.stringify(title)} as ${id}, but it is waiting for the user's OK in Fanfold, because ${why}. `
    + 'Until the user allows it under Documents on the Profile page of Fanfold\'s own window, files_read, files_search and browser_upload cannot use it. '
    + `Tell the user; do not try to reach its contents another way.${notes}`;
}

/**
 * Ask the host's user straight away whether an agent may use a file it
 * imported that is not plainly their résumé or cover letter. Allowed, it can
 * be used at once; declined, Fanfold's copy is deleted. Anything else leaves
 * it waiting in Fanfold's own window. Null when this host cannot ask.
 */
async function askToKeep(
  ctx: FanfoldContext, call: CallContext, doc: { id: string; why: string }, file: { name: string; folder: string; bytes: number },
): Promise<'allowed' | 'removed' | 'waiting' | null> {
  if (ctx.approvalsVia !== 'host' || !call.client.elicitation || !call.peer.request) return null;
  const { memory } = ctx.app;
  // Allowed or removed in Fanfold's own window meanwhile: the dialog is withdrawn.
  const dialog = openDialog(call, {
    message: [
      `${call.client.name ? `An agent (${call.client.name})` : 'An outside agent'} asked Fanfold to import a file from this computer:`, '',
      file.name, `in ${file.folder}, ${size(file.bytes)}`, '',
      `Fanfold is asking because ${doc.why}.`, '',
      'Let the agent read and use it? If you decline, Fanfold deletes its copy. Your own file is not touched.',
    ].join('\n'),
    requestedSchema: { type: 'object', properties: {} },
  }, () => !memory.documentHeld(doc.id), ctx.log);
  const decide = (answer: Reply | null): void => {
    if (answer?.action === 'accept' && memory.releaseDocument(doc.id)) ctx.emit({ type: 'document_allowed', id: doc.id });
    if (answer?.action === 'decline' && memory.documentHeld(doc.id)) {
      memory.deleteDocument(doc.id);
      ctx.app.careers.delete(doc.id);
      ctx.emit({ type: 'document_removed', id: doc.id });
    }
  };
  const answer = await waitForReply(dialog, call.signal);
  // Not answered within the minute: the file waits in Fanfold, and the user's word in the dialog later still counts.
  if (answer === 'later') void dialog.reply.then(decide);
  else decide(answer);
  // The user may have answered in Fanfold's own window while the host was asking.
  const now = memory.listDocuments({ includeHeld: true }).find((d) => d.id === doc.id);
  return !now ? 'removed' : now.held ? 'waiting' : 'allowed';
}

/**
 * Whether a file names the user. A library can hold an old CV or someone
 * else's, and a title says nothing about whose it is: picked by title alone,
 * another person's résumé goes out on the user's applications.
 */
export function whoseFile(ctx: FanfoldContext, id: string): string {
  return whoseText(ctx.app.profile.fact('name')?.value, ctx.app.memory.documentOpening(id));
}

export function fileTools(ctx: FanfoldContext): Tool[] {
  const list: Tool = {
    name: 'files_list',
    title: 'List the user\'s files',
    description: 'The files the user has given Fanfold, with the id each is attached by (browser_upload) and whether it can still be attached.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true },
    run: async () => {
      const documents = ctx.app.memory.listDocuments({ includeHeld: true });
      if (!documents.length) return 'The user has not given Fanfold any files yet. files_add imports one from a path they name.';
      const attachable = new Set(ctx.app.memory.uploadableDocuments().map((d) => d.id));
      return documents.map((d) => {
        if (d.held) return `${d.id}  ${JSON.stringify(d.title)}  added ${d.addedAt.slice(0, 10)}  (${HELD})`;
        const whose = whoseFile(ctx, d.id);
        const note = !d.chunks
          ? (attachable.has(d.id) ? '  (no readable text: it can be attached, not searched or read)' : '  (no readable text, and its file is gone)')
          : attachable.has(d.id) ? '' : '  (text only, cannot be attached)';
        // Once the owner said it is theirs, it is theirs: who imported it first no longer matters.
        const by = d.importedBy && !d.trusted ? `  (${AGENT_IMPORTED})` : '';
        return `${d.id}  ${JSON.stringify(d.title)}  added ${d.addedAt.slice(0, 10)}${whose ? `  (${whose})` : ''}${by}${note}`;
      }).join('\n');
    },
  };

  const add: Tool = {
    name: 'files_add',
    title: 'Import a file from the user',
    description:
      'Import a file the user pointed you at, so its text can be searched and the file attached to forms. '
      + 'PDF, DOCX, TXT, MD or RTF, by full path (~/ is the home folder). Only import a file the user asked you to use. '
      + 'Given a folder, it imports nothing and lists only the files directly inside it that are named as a résumé, CV or cover letter, '
      + 'newest first, to choose from. A PDF whose text cannot be read, such as a scan, is not imported: the user can add one themselves in Fanfold. '
      + 'The user\'s own résumé, CV or cover letter (one that names them) can be used at once. Any other file is kept but waits for the user\'s OK: '
      + 'Fanfold asks them in this app when it can, or else in Fanfold\'s own window, and until they allow it nothing can read, search or attach it. '
      + 'Once they allow it, it is theirs and is attached like any other of their files.',
    inputSchema: {
      type: 'object', required: ['path'], additionalProperties: false,
      properties: {
        path: { type: 'string', maxLength: 2000, description: 'Full path on this computer, or one starting with ~/. A folder lists the résumés, CVs and cover letters in it.' },
        title: { type: 'string', maxLength: 200, description: 'What to call it. Defaults to the file name.' },
      },
    },
    run: async (args, call) => {
      const file = await readImportable(String(args.path));
      if (file.kind === 'folder') return folderListing(file);
      const extracted = await extractTextOffThread(file.bytes, file.mime);
      // Judged by the name on disk, never by a title the agent chose, and a
      // file that waits is shown to the user by that name too.
      const held = extracted.ok ? importHold(ctx.app.profile.fact('name')?.value, file.name, extracted.text) : null;
      const title = !held && typeof args.title === 'string' && args.title.trim() ? args.title.trim() : file.name;
      const imported = importDocument(ctx.app.memory, {
        title, bytes: file.bytes, mime: file.mime, importedBy: `agent:${call.client.name || 'an outside agent'}`, extracted, held,
      });
      if (!imported.ok) {
        throw new Error(imported.unreadable ? `${JSON.stringify(file.name)}: ${UNREADABLE_REFUSED}.` : imported.error);
      }
      ctx.emit({ type: imported.held ? 'document_held' : 'document_added', id: imported.id, title: imported.title });
      const notes = imported.warnings.length ? ` Notes: ${imported.warnings.join('; ')}.` : '';
      const ready = `imported ${JSON.stringify(imported.title)} as ${imported.id} (${imported.characters} characters of text).${notes}`;
      if (imported.held) {
        // Asked once, when the file first comes in; a second import of it waits like the first.
        const answer = imported.existing ? null
          : await askToKeep(ctx, call, { id: imported.id, why: imported.held }, { name: file.name, folder: file.folder, bytes: file.bytes.length });
        const host = call.client.name || 'the host';
        if (answer === 'allowed') {
          void ctx.app.fillProfileFrom(imported.id);
          return `${ready} The user allowed it in ${host}.`;
        }
        if (answer === 'removed') {
          return `The user declined, so ${JSON.stringify(imported.title)} was not imported and Fanfold kept no copy. `
            + 'Do not try to reach its contents another way; ask the user what they want instead.';
        }
        return heldReply(imported.title, imported.id, imported.held, notes);
      }
      if (imported.unreadable) return `imported ${JSON.stringify(imported.title)} as ${imported.id}, but ${UNREADABLE}.${notes}`;
      // What it says about the user is proposed for their profile; it answers forms only once they say the file is theirs.
      void ctx.app.fillProfileFrom(imported.id);
      return ready;
    },
  };

  const search: Tool = {
    name: 'files_search',
    title: 'Search the user\'s files',
    description:
      'Find passages in the user\'s files: their experience, dates, skills, the wording of their cover letter. '
      + 'Use this rather than guessing what a résumé says.',
    inputSchema: {
      type: 'object', required: ['query'], additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 400 },
        limit: { type: 'integer', minimum: 1, maximum: 12, description: 'Passages to return. Default 5.' },
      },
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const hits = ctx.app.memory.searchDocuments(String(args.query), typeof args.limit === 'number' ? args.limit : 5);
      const held = ctx.app.memory.listDocuments({ includeHeld: true }).filter((d) => d.held).map((d) => JSON.stringify(d.title));
      const waiting = held.length
        ? `\nNot searched, as they wait for the user's OK in Fanfold: ${held.join(', ')}. Tell the user if you need one; do not try to reach its contents another way.`
        : '';
      if (!hits.length) return `Nothing in the user's files matches that.${waiting}`;
      return hits.map((h) => fenceBlock(h.text, `file:${h.title}`)).join('\n\n') + waiting;
    },
  };

  const read: Tool = {
    name: 'files_read',
    title: 'Read one of the user\'s files',
    description:
      'The whole text of a file the user gave Fanfold, such as their résumé, by its id from files_list. '
      + 'Read it before filling an application from it, rather than guessing what it says.',
    inputSchema: {
      type: 'object', required: ['id'], additionalProperties: false,
      properties: { id: { type: 'string', minLength: 1, maxLength: 64, description: 'A file id from files_list.' } },
    },
    annotations: { readOnlyHint: true },
    run: async (args) => {
      const doc = ctx.app.memory.uploadableDocument(String(args.id));
      const held = doc ? null : ctx.app.memory.documentHeld(String(args.id));
      if (held) throw new Error(waitingText(held.title, 'read'));
      if (!doc) throw new Error(`no readable file with id ${String(args.id)}; files_list shows the ids`);
      const extracted = await extractTextOffThread(await readFile(doc.path));
      if (!extracted.ok && extracted.unreadable) {
        throw new Error(`${JSON.stringify(doc.title)}: ${UNREADABLE}.${extracted.warnings?.length ? ` (${extracted.warnings.join('; ')})` : ''}`);
      }
      if (!extracted.ok) throw new Error(extracted.error);
      const cut = extracted.text.length > MAX_READ ? `${extracted.text.slice(0, MAX_READ)}\n… cut at ${MAX_READ} characters` : extracted.text;
      return fenceBlock(cut, `file:${doc.title}`);
    },
  };

  return [list, add, search, read];
}
