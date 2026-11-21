/**
 * Text out of a .docx, with no dependency.
 *
 * A .docx is a zip whose word/document.xml holds the body. This reads the
 * zip's central directory, inflates that one entry and keeps the text runs,
 * one line per paragraph. Formatting, headers and footnotes are ignored: the
 * text is indexed for search and shown to the user, and the original file is
 * what gets attached to a form.
 */
import { inflateRawSync } from 'node:zlib';

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const MAX_XML_BYTES = 64 * 1024 * 1024;

export function isZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.readUInt32LE(0) === LOCAL_HEADER;
}

/** The bytes of one entry, or null when the archive has no such entry. */
export function readZipEntry(buffer: Buffer, name: string): Buffer | null {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === END_OF_DIRECTORY) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip archive: no end-of-directory record');

  const entries = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  for (let n = 0; n < entries; n++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== DIRECTORY_ENTRY) {
      throw new Error('the zip directory is damaged');
    }
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const entryName = buffer.toString('utf8', at + 46, at + 46 + nameLength);

    if (entryName === name) {
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_HEADER) {
        throw new Error('the zip entry is damaged');
      }
      const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      const data = buffer.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES });
      throw new Error(`zip compression method ${method} is not supported`);
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function extractDocxText(buffer: Buffer): string {
  const xml = readZipEntry(buffer, 'word/document.xml');
  if (!xml) throw new Error('not a Word document: it has no word/document.xml');

  const lines: string[] = [];
  for (const paragraph of xml.toString('utf8').split(/<\/w:p>/)) {
    const marked = paragraph
      .replace(/<w:tab\b[^>]*\/>/g, '<w:t>\t</w:t>')
      .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '<w:t>\n</w:t>');
    let line = '';
    for (const run of marked.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) line += decode(run[1]);
    lines.push(line.trimEnd());
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
