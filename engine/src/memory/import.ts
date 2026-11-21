/** One way to turn a file or pasted text into a searchable, attachable document. */
import { createHash } from 'node:crypto';
import type { Memory } from './memory.ts';
import { extractPdfText, type PdfExtraction } from './pdf.ts';
import { extractPdfTextOffThread } from './pdf-thread.ts';
import { extractDocxText, isZip } from './docx.ts';

/** The largest file that will be imported. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** What the person reads when a file cannot be imported. */
export const COPY = {
  tooBig: 'it is over 20 MB, the largest file Fanfold takes',
  noText: 'it has no text in it',
  damagedPdf: 'this PDF is damaged or cut short, so it can’t be read or sent with an application. Save or download it again, then import the new copy',
};

type Imported =
  | {
    ok: true; id: string; title: string; characters: number; warnings: string[]; unreadable?: boolean;
    /** Why it waits for the owner's OK. `existing` says it was imported before, so this import changed nothing. */
    held?: string; existing?: boolean;
  }
  | { ok: false; status: 400 | 422; error: string; warnings?: string[]; unreadable?: true };

/** Text could not be read from a file that is otherwise what it says it is. */
type Unreadable = { ok: false; status: 422; error: string; warnings?: string[]; unreadable?: true };

type Extracted = ReturnType<typeof extractText>;

/**
 * `keepUnreadable` keeps a PDF whose text cannot be read as a file with no
 * text: it can still be attached to a form, and nothing unreadable is indexed.
 * Only the owner's own import passes it: an outside agent cannot tell what an
 * unreadable file is, and neither can Fanfold.
 *
 * `importedBy` names the outside agent importing it; left out, it is the
 * owner, who also takes over a copy an agent imported before, and so allows
 * it. `held` keeps a new document from being read until the owner allows it;
 * an agent importing the same bytes again never allows it. `extracted` is
 * the file's text when the caller already read it, off the main thread.
 */
export function importDocument(
  memory: Memory,
  input: {
    title: string; text?: string; bytes?: Buffer; mime?: string; keepUnreadable?: boolean; importedBy?: string | null; extracted?: Extracted;
    held?: string | null;
  },
): Imported {
  const title = input.title.trim();
  if (!title) return { ok: false, status: 400, error: 'a title is required' };

  let text = input.text ?? '';
  const warnings: string[] = [];
  const bytes = input.bytes;

  if (bytes) {
    if (bytes.length > MAX_DOCUMENT_BYTES) {
      return { ok: false, status: 400, error: COPY.tooBig };
    }
    // The same file given twice is one file. Copies of one résumé under one
    // name leave nobody able to tell which is meant.
    const same = memory.documentWithSha(createHash('sha256').update(bytes).digest('hex'));
    if (same) {
      if (!input.importedBy) memory.ownDocument(same.id);
      // Held before, and judged fine now (the profile has a name to check it against since): it waits no longer.
      else if (same.held && !input.held && memory.releaseDocument(same.id)) same.held = null;
      const already = `already imported as ${JSON.stringify(same.title)}, so that copy is used`;
      const kept = { ok: true as const, id: same.id, title: same.title, existing: true, ...(input.importedBy && same.held ? { held: same.held } : {}) };
      if (same.characters) return { ...kept, characters: same.characters, warnings: [already] };
      // Kept without its text by an earlier import: the reader may manage it now.
      const extracted = input.extracted ?? extractText(bytes, input.mime);
      if (extracted.ok && extracted.text.trim() && memory.fillDocumentText(same.id, extracted.text)) {
        const warnings = [already, 'its text could not be read before and now can, so it is searchable', ...extracted.warnings];
        return { ...kept, characters: extracted.text.length, warnings };
      }
      const why = extracted.ok ? [] : extracted.warnings ?? [];
      return { ...kept, characters: 0, warnings: [already, ...why], unreadable: true };
    }
    const extracted = input.extracted ?? extractText(bytes, input.mime);
    if (!extracted.ok && extracted.unreadable && input.keepUnreadable) {
      const id = memory.addDocument({ title, text: '', mime: input.mime, bytes, importedBy: input.importedBy, held: input.held });
      return { ok: true, id, title, characters: 0, warnings: extracted.warnings ?? [], unreadable: true, ...(input.held ? { held: input.held } : {}) };
    }
    if (!extracted.ok) return extracted;
    warnings.push(...extracted.warnings);
    text = extracted.text;
  }

  if (!text.trim()) return { ok: false, status: 400, error: COPY.noText };

  const id = memory.addDocument({ title, text, mime: input.mime, bytes, importedBy: input.importedBy, held: input.held });
  return { ok: true, id, title, characters: text.length, warnings, ...(input.held ? { held: input.held } : {}) };
}

/**
 * The text of a file, read the way its contents say it is, not its name: a
 * file called .docx that is not a Word document is refused rather than
 * indexed as noise, and RTF is read as words rather than markup.
 */
export function extractText(bytes: Buffer, mime?: string): { ok: true; text: string; warnings: string[] } | Unreadable {
  if (isPdf(bytes)) return fromPdf(extractPdfText(bytes), bytes);
  if (isZip(bytes)) {
    try {
      return { ok: true, text: extractDocxText(bytes), warnings: [] };
    } catch (err) {
      return { ok: false, status: 422, error: `could not read this file as a Word document: ${(err as Error).message}` };
    }
  }
  if (mime === 'application/pdf' || mime?.includes('wordprocessingml')) {
    return { ok: false, status: 422, error: `this file is named as a ${mime === 'application/pdf' ? 'PDF' : 'Word document'} but is not one` };
  }
  const raw = bytes.toString('utf8');
  if (raw.includes('\uFFFD') && raw.split('\uFFFD').length > raw.length / 50) {
    return { ok: false, status: 422, error: 'this file is not text, a PDF or a Word document' };
  }
  return { ok: true, text: raw.trimStart().startsWith('{\\rtf') ? rtfToText(raw) : raw, warnings: [] };
}

/** extractText, with a PDF read in a worker thread so no file can stall the process. */
export async function extractTextOffThread(bytes: Buffer, mime?: string): Promise<Extracted> {
  return isPdf(bytes) ? fromPdf(await extractPdfTextOffThread(bytes), bytes) : extractText(bytes, mime);
}

const isPdf = (bytes: Buffer): boolean => bytes.subarray(0, 5).toString('latin1') === '%PDF-';

/** A PDF whose end is missing: every whole PDF closes with %%EOF, and one cut short has none at its end. */
const cutShort = (bytes: Buffer): boolean => !bytes.subarray(-2048).toString('latin1').includes('%%EOF');

function fromPdf(extracted: PdfExtraction, bytes: Buffer): Extracted {
  // A damaged file is refused, not kept as if it were a scan: attached to an application, it would arrive broken.
  if (extracted.confidence < 0.6 && cutShort(bytes)) return { ok: false, status: 422, error: COPY.damagedPdf };
  if (extracted.confidence < 0.6) {
    return {
      ok: false, status: 422, warnings: extracted.warnings, unreadable: true,
      error: 'could not read text from this PDF — it is probably a scan, encrypted, or uses a font with no text mapping. Paste the text instead.',
    };
  }
  return { ok: true, text: extracted.text, warnings: extracted.warnings };
}

/** RTF's words without its markup: enough for a résumé saved from a word processor. */
function rtfToText(rtf: string): string {
  return rtf
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\par[d]?\b ?/g, '\n')
    .replace(/\\'([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n: string) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)))
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
