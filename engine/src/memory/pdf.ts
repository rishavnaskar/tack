/**
 * PDF text extraction, with no dependencies.
 *
 * A user's résumé is a PDF, so "import a document" that only accepts plain
 * text is not the feature. This reads the file's objects, including those
 * packed into compressed object streams, walks the page tree, and runs each
 * page's content stream with enough of the graphics state to know where every
 * glyph lands. Glyph codes become text through the font's ToUnicode map, or
 * its encoding when there is none. Words and lines come from those positions
 * rather than from the operators, because generators differ: Chrome places
 * every glyph with its own Td, and a TJ kern can be a space or not.
 *
 * What it does NOT do, stated plainly because the failure is silent
 * otherwise:
 *
 *  - No OCR. A scanned page has no text and yields nothing.
 *  - No decryption. An encrypted file is reported, not read.
 *  - A font with neither a ToUnicode map nor a known encoding gives glyph
 *    numbers, not letters. They come out as U+FFFD, and `confidence` scores
 *    the result so a caller can refuse it instead of indexing rubbish.
 */

import { constants as zlib, inflateRawSync, inflateSync } from 'node:zlib';
import { Lexer, Name, Op, PdfString, Ref, Stream, bytesToInt, hexBytes, type Dict, type Value } from './pdf-syntax.ts';

export interface PdfExtraction {
  text: string;
  pages: number;
  /** 0–1. Below ~0.6 the output is probably glyph codes, not words. */
  confidence: number;
  warnings: string[];
}

/**
 * What one file may cost, many times what a résumé needs. A file that needs
 * more is not read at all and counts as one whose text cannot be read: a
 * few kilobytes can ask for gigabytes of output or billions of steps.
 */
const PDF_LIMITS = {
  /** Decoded bytes of one stream. */
  streamBytes: 32 * 1024 * 1024,
  /** Decoded bytes of every stream in the file together. */
  decodedBytes: 96 * 1024 * 1024,
  /** Tokens run through the content streams, forms included. */
  tokens: 30_000_000,
  /** Times a form XObject is drawn. */
  forms: 20_000,
  ms: 8_000,
};

/** A file asked for more than PDF_LIMITS allows. */
class BudgetSpent extends Error {}

export function extractPdfText(buffer: Buffer): PdfExtraction {
  if (!buffer.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
    return { text: '', pages: 0, confidence: 0, warnings: ['not a PDF'] };
  }
  try {
    return read(buffer);
  } catch (err) {
    if (err instanceof BudgetSpent) {
      return { text: '', pages: 0, confidence: 0, warnings: [`reading stopped: ${err.message}, more than any résumé needs, so its text is not read`] };
    }
    return { text: '', pages: 0, confidence: 0, warnings: [`the PDF could not be parsed: ${(err as Error).message}`] };
  }
}

/** What reading one file has cost so far. */
class Budget {
  decoded = 0;
  tokens = 0;
  forms = 0;
  readonly #started = performance.now();

  /** Called every so often from the long loops. */
  tick(): void {
    if (performance.now() - this.#started > PDF_LIMITS.ms) throw new BudgetSpent(`it took longer than ${PDF_LIMITS.ms / 1000} s`);
  }

  token(): void {
    if (++this.tokens > PDF_LIMITS.tokens) throw new BudgetSpent(`it has more than ${PDF_LIMITS.tokens} drawing steps`);
    if ((this.tokens & 0xfff) === 0) this.tick();
  }

  form(): void {
    if (++this.forms > PDF_LIMITS.forms) throw new BudgetSpent(`it draws forms more than ${PDF_LIMITS.forms} times`);
  }

  /** How much one more stream may decode to, and what to say when it would decode to more. */
  room(): { bytes: number; why: string } {
    const left = PDF_LIMITS.decodedBytes - this.decoded;
    const total = `it decodes to more than ${PDF_LIMITS.decodedBytes / 1048576} MB`;
    if (left <= 0) throw new BudgetSpent(total);
    return left < PDF_LIMITS.streamBytes
      ? { bytes: left, why: total }
      : { bytes: PDF_LIMITS.streamBytes, why: `a stream in it decodes to more than ${PDF_LIMITS.streamBytes / 1048576} MB` };
  }
}

function read(buffer: Buffer): PdfExtraction {
  const file = new PdfFile(buffer);
  const pages = file.pages();
  if (file.encrypted()) {
    return { text: '', pages: pages.length, confidence: 0, warnings: ['the document is encrypted, and Fanfold cannot decrypt it to read its text'] };
  }

  const warnings: string[] = [];
  const reader = new Reader(file);
  const texts: string[] = [];
  for (const page of pages) {
    file.budget.tick();
    reader.glyphs = [];
    reader.run(file.contents(page.dict), page.resources, startState(), 0);
    texts.push(layout(reader.glyphs));
    if (reader.count >= MAX_GLYPHS) {
      warnings.push(`stopped after ${MAX_GLYPHS} characters`);
      break;
    }
  }

  const text = normalise(texts.join('\n\n'));
  const confidence = scoreText(text);
  if (!text) warnings.push('no text found: the pages may be scanned images');
  else if (confidence < 0.6) {
    warnings.push('the extracted text does not look like words: a font probably has no mapping from its glyphs to text');
  } else if (reader.unmapped > reader.count * 0.02) {
    warnings.push(`${reader.unmapped} of ${reader.count} characters have no mapping to text and show as \uFFFD`);
  }
  return { text, pages: pages.length, confidence, warnings };
}

/**
 * Every object in the file, found by scanning rather than through the
 * cross-reference table, so a file with a broken or missing one still reads.
 * When a number is defined twice, the later definition wins: that is what an
 * incremental update means.
 */
class PdfFile {
  readonly buf: Buffer;
  readonly src: string;
  readonly #objects = new Map<number, { value: Value; at: number }>();
  readonly #decoded = new WeakMap<Stream, string>();
  readonly #cmaps = new WeakMap<Stream, CMap>();
  readonly budget = new Budget();

  constructor(buf: Buffer) {
    this.buf = buf;
    this.src = buf.toString('latin1');
    this.#scan();
    this.#unpackObjectStreams();
  }

  #scan(): void {
    const re = /(\d+)\s+\d+\s+obj\b/g;
    for (let m = re.exec(this.src); m; m = re.exec(this.src)) {
      const lx = new Lexer(this.src, re.lastIndex);
      let value = lx.next();
      if (value === undefined || value instanceof Op) value = null;
      if (value instanceof Map) {
        lx.skipSpace();
        if (this.src.startsWith('stream', lx.pos)) {
          const { from, to, next } = this.#streamBounds(lx.pos + 6, value);
          value = new Stream(value, this.buf.subarray(from, to));
          lx.pos = next;
        }
      }
      re.lastIndex = Math.max(re.lastIndex, lx.pos);
      this.#define(Number(m[1]), value, m.index);
    }
  }

  #streamBounds(start: number, dict: Dict): { from: number; to: number; next: number } {
    const s = this.src;
    let from = start;
    if (s[from] === '\r') from++;
    if (s[from] === '\n') from++;
    const length = dict.get('Length');
    if (typeof length === 'number' && length >= 0 && from + length <= s.length) {
      const after = new Lexer(s, from + length);
      after.skipSpace();
      if (s.startsWith('endstream', after.pos)) return { from, to: from + length, next: after.pos + 9 };
    }
    const end = s.indexOf('endstream', from);
    if (end === -1) return { from, to: s.length, next: s.length };
    let to = end;
    if (s[to - 1] === '\n') to--;
    if (s[to - 1] === '\r') to--;
    return { from, to: Math.max(from, to), next: end + 9 };
  }

  #define(num: number, value: Value, at: number): void {
    const had = this.#objects.get(num);
    if (!had || had.at <= at) this.#objects.set(num, { value, at });
  }

  /** PDF 1.5 packs most objects, fonts included, into compressed object streams. */
  #unpackObjectStreams(): void {
    const packed = [...this.#objects.values()]
      .filter((o) => o.value instanceof Stream && this.name(o.value.dict.get('Type')) === 'ObjStm');
    for (const { value, at } of packed) {
      const stream = value as Stream;
      const data = this.text(stream);
      const count = this.num(stream.dict.get('N')) ?? 0;
      const first = this.num(stream.dict.get('First')) ?? 0;
      const header = new Lexer(data.slice(0, first));
      const entries: number[] = [];
      for (let i = 0; i < count * 2; i++) {
        const t = header.next();
        if (typeof t !== 'number') break;
        entries.push(t);
      }
      // Each object is read only up to where the next one starts, and once per
      // place: entries all pointing at one unclosed array would otherwise each
      // read the rest of the stream.
      const starts = [...new Set(entries.filter((_, i) => i % 2 === 1))].sort((a, b) => a - b);
      const values = new Map<number, Value | Op | undefined>();
      starts.forEach((offset, i) => {
        this.budget.tick();
        const to = i + 1 < starts.length ? first + starts[i + 1] : data.length;
        values.set(offset, new Lexer(data.slice(0, to), first + offset).next());
      });
      for (let i = 0; i + 1 < entries.length; i += 2) {
        const v = values.get(entries[i + 1]);
        this.#define(entries[i], v === undefined || v instanceof Op ? null : v, at);
      }
    }
  }

  resolve(v: Value | undefined): Value | undefined {
    for (let i = 0; v instanceof Ref && i < 32; i++) v = this.#objects.get(v.num)?.value;
    return v instanceof Ref ? undefined : v;
  }

  dict(v: Value | undefined): Dict | undefined { const r = this.resolve(v); return r instanceof Map ? r : undefined; }
  num(v: Value | undefined): number | undefined { const r = this.resolve(v); return typeof r === 'number' ? r : undefined; }
  name(v: Value | undefined): string | undefined { const r = this.resolve(v); return r instanceof Name ? r.value : undefined; }

  /** An array, or a single value standing in for one. */
  list(v: Value | undefined): Value[] {
    const r = this.resolve(v);
    return Array.isArray(r) ? r : r === undefined || r === null ? [] : [r];
  }

  /** A stream's decoded bytes, one char per byte. Empty when it cannot be decoded. */
  text(stream: Stream): string {
    let t = this.#decoded.get(stream);
    if (t === undefined) {
      try {
        t = this.#decode(stream).toString('latin1');
      } catch (err) {
        if (err instanceof BudgetSpent) throw err;
        t = '';
      }
      this.budget.decoded += t.length;
      this.#decoded.set(stream, t);
    }
    return t;
  }

  #decode(stream: Stream): Buffer {
    let data = stream.raw;
    for (const filter of this.list(stream.dict.get('Filter'))) {
      const name = this.name(filter);
      if (name === 'FlateDecode' || name === 'Fl') data = inflate(data, this.budget.room());
      else if (name === 'ASCIIHexDecode' || name === 'AHx') data = Buffer.from(hexBytes(data.toString('latin1').split('>')[0]), 'latin1');
      else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85(data.toString('latin1'));
      else throw new Error(`unsupported filter ${name}`);
    }
    return data;
  }

  encrypted(): boolean {
    const at = this.src.lastIndexOf('trailer');
    const trailer = at === -1 ? undefined : new Lexer(this.src, at + 7).next();
    if (trailer instanceof Map && trailer.has('Encrypt')) return true;
    for (const { value } of this.#objects.values()) {
      if (value instanceof Stream && this.name(value.dict.get('Type')) === 'XRef' && value.dict.has('Encrypt')) return true;
    }
    return false;
  }

  /** Pages in reading order, each with the resources it inherits. */
  pages(): Array<{ dict: Dict; resources: Dict | undefined }> {
    const out: Array<{ dict: Dict; resources: Dict | undefined }> = [];
    const seen = new Set<Dict>();
    const walk = (node: Dict | undefined, resources: Dict | undefined): void => {
      if (!node || seen.has(node) || out.length >= 10_000) return;
      seen.add(node);
      const own = this.dict(node.get('Resources')) ?? resources;
      const kids = this.resolve(node.get('Kids'));
      if (Array.isArray(kids)) for (const kid of kids) walk(this.dict(kid), own);
      else if (this.name(node.get('Type')) !== 'Pages') out.push({ dict: node, resources: own });
    };
    let catalog: { value: Value; at: number } | undefined;
    for (const o of this.#objects.values()) {
      if (o.value instanceof Map && this.name(o.value.get('Type')) === 'Catalog' && (!catalog || o.at > catalog.at)) catalog = o;
    }
    if (catalog) walk(this.dict((catalog.value as Dict).get('Pages')), undefined);
    if (out.length) return out;

    // No usable page tree: every page object, in file order.
    const loose = [...this.#objects.values()]
      .filter((o) => o.value instanceof Map && this.name(o.value.get('Type')) === 'Page')
      .sort((a, b) => a.at - b.at);
    for (const { value } of loose) {
      let resources: Dict | undefined;
      for (let node = value as Dict | undefined, i = 0; node && !resources && i < 32; node = this.dict(node.get('Parent')), i++) {
        resources = this.dict(node.get('Resources'));
      }
      out.push({ dict: value as Dict, resources });
    }
    return out;
  }

  contents(page: Dict): string {
    const parts = this.list(page.get('Contents'))
      .map((part) => this.resolve(part))
      .filter((part): part is Stream => part instanceof Stream)
      .map((part) => this.text(part));
    // One stream named many times over is many times its size once joined.
    if (parts.reduce((n, p) => n + p.length + 1, 0) > PDF_LIMITS.decodedBytes) {
      throw new BudgetSpent(`a page's content comes to more than ${PDF_LIMITS.decodedBytes / 1048576} MB`);
    }
    return parts.join('\n');
  }

  /** A CMap stream, read once however many fonts name it, its steps counted with the drawing's. */
  cmap(stream: Stream): CMap {
    let parsed = this.#cmaps.get(stream);
    if (!parsed) this.#cmaps.set(stream, parsed = parseCMap(this.text(stream), () => this.budget.token()));
    return parsed;
  }
}

function inflate(data: Buffer, room: { bytes: number; why: string }): Buffer {
  const maxOutputLength = room.bytes;
  const tooLarge = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE';
  const spent = (): BudgetSpent => new BudgetSpent(room.why);
  try {
    return inflateSync(data, { maxOutputLength });
  } catch (err) {
    if (tooLarge(err)) throw spent();
    // A truncated stream still holds everything before the cut.
    try {
      return inflateSync(data, { finishFlush: zlib.Z_SYNC_FLUSH, maxOutputLength });
    } catch (again) {
      if (tooLarge(again)) throw spent();
      try {
        return inflateRawSync(data, { finishFlush: zlib.Z_SYNC_FLUSH, maxOutputLength });
      } catch (raw) {
        throw tooLarge(raw) ? spent() : raw;
      }
    }
  }
}

function ascii85(s: string): Buffer {
  const body = s.replace(/\s+/g, '').replace(/^<~/, '').split('~>')[0].replace(/z/g, '!!!!!');
  const out: number[] = [];
  for (let i = 0; i < body.length; i += 5) {
    const group = body.slice(i, i + 5);
    let v = 0;
    for (let j = 0; j < 5; j++) v = v * 85 + (j < group.length ? group.charCodeAt(j) - 33 : 84);
    out.push(...[v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255].slice(0, group.length - 1));
  }
  return Buffer.from(out);
}

interface Font {
  /** A string's bytes as character codes, with how many bytes each took. */
  split(bytes: string): Array<[code: number, length: number]>;
  /** The text a code stands for, or undefined when the font does not say. */
  text(code: number): string | undefined;
  /** Advance width in text-space units, for a font size of 1. */
  width(code: number): number;
}

interface CodeSpace { lo: number; hi: number; len: number }

interface CMap {
  spaces: CodeSpace[];
  unicode: Map<number, string>;
  cids: Array<[lo: number, hi: number, cid: number]>;
}

const TWO_BYTES: CodeSpace[] = [{ lo: 0, hi: 0xffff, len: 2 }];
const MAX_RANGE = 1 << 17;

/** A CMap: a ToUnicode map, or an embedded encoding for a composite font. */
function parseCMap(text: string, step: () => void): CMap {
  const cmap: CMap = { spaces: [], unicode: new Map(), cids: [] };
  const lx = new Lexer(text);
  let args: Value[] = [];
  let budget = MAX_RANGE * 4;
  for (let t = lx.next(); t !== undefined; t = lx.next()) {
    step();
    if (!(t instanceof Op)) { args.push(t); continue; }
    const strings = (i: number, n: number): boolean => args.slice(i, i + n).every((a) => a instanceof PdfString);
    if (t.op === 'endcodespacerange') {
      for (let i = 0; i + 1 < args.length; i += 2) {
        if (!strings(i, 2)) continue;
        const lo = (args[i] as PdfString).bytes;
        cmap.spaces.push({ lo: bytesToInt(lo), hi: bytesToInt((args[i + 1] as PdfString).bytes), len: lo.length });
      }
    } else if (t.op === 'endbfchar') {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const dst = args[i + 1];
        if (!strings(i, 1)) continue;
        cmap.unicode.set(bytesToInt((args[i] as PdfString).bytes), dst instanceof Name ? glyphName(dst.value) : dst instanceof PdfString ? utf16(dst.bytes) : '');
      }
    } else if (t.op === 'endbfrange') {
      for (let i = 0; i + 2 < args.length; i += 3) {
        if (!strings(i, 2)) continue;
        const lo = bytesToInt((args[i] as PdfString).bytes);
        const hi = Math.min(bytesToInt((args[i + 1] as PdfString).bytes), lo + MAX_RANGE);
        const dst = args[i + 2];
        for (let code = lo; code <= hi && budget-- > 0; code++) {
          if (Array.isArray(dst)) {
            const one = dst[code - lo];
            if (one instanceof PdfString) cmap.unicode.set(code, utf16(one.bytes));
          } else if (dst instanceof PdfString) {
            const base = utf16(dst.bytes);
            cmap.unicode.set(code, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + code - lo));
          }
        }
      }
    } else if (t.op === 'endcidchar' || t.op === 'endcidrange') {
      const step = t.op === 'endcidchar' ? 2 : 3;
      for (let i = 0; i + step - 1 < args.length; i += step) {
        const cid = args[i + step - 1];
        if (!strings(i, step - 1) || typeof cid !== 'number') continue;
        const lo = bytesToInt((args[i] as PdfString).bytes);
        cmap.cids.push([lo, step === 2 ? lo : bytesToInt((args[i + 1] as PdfString).bytes), cid]);
      }
    }
    args = [];
  }
  return cmap;
}

/** A text string: UTF-16 or UTF-8 behind a byte-order mark, otherwise close enough to Latin-1. */
function textString(bytes: string): string {
  if (bytes.startsWith('\xfe\xff')) return utf16(bytes.slice(2));
  if (bytes.startsWith('\xef\xbb\xbf')) return Buffer.from(bytes.slice(3), 'latin1').toString('utf8');
  return bytes;
}

/** UTF-16BE, as ToUnicode maps are written. */
function utf16(bytes: string): string {
  if (bytes.length % 2) return bytes;
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
  return out;
}

function splitCodes(bytes: string, spaces: CodeSpace[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < bytes.length;) {
    let code = 0;
    let len = 0;
    for (let n = 1; n <= 4 && i + n <= bytes.length; n++) {
      code = code * 256 + bytes.charCodeAt(i + n - 1);
      if (spaces.some((s) => s.len === n && code >= s.lo && code <= s.hi)) { len = n; break; }
    }
    if (!len) {
      len = Math.max(1, Math.min(spaces[0]?.len ?? 1, bytes.length - i));
      code = bytesToInt(bytes.slice(i, i + len));
    }
    out.push([code, len]);
    i += len;
  }
  return out;
}

function loadFont(file: PdfFile, dict: Dict): Font {
  const map = file.resolve(dict.get('ToUnicode'));
  const toUnicode = map instanceof Stream ? file.cmap(map) : null;
  return file.name(dict.get('Subtype')) === 'Type0' ? compositeFont(file, dict, toUnicode) : simpleFont(file, dict, toUnicode);
}

/** Type0: multi-byte codes, usually Identity-H, where a code is a glyph id and only ToUnicode says what it shows. */
function compositeFont(file: PdfFile, dict: Dict, toUnicode: CMap | null): Font {
  const descendant = file.dict(file.list(dict.get('DescendantFonts'))[0]);
  const encoding = file.resolve(dict.get('Encoding'));
  const embedded = encoding instanceof Stream ? file.cmap(encoding) : null;
  const named = encoding instanceof Name ? encoding.value : '';
  const spaces = embedded?.spaces.length ? embedded.spaces
    : named.startsWith('Identity') || !toUnicode?.spaces.length ? TWO_BYTES : toUnicode.spaces;
  // Predefined Unicode CMaps make the code the character itself.
  const unicodeCodes = /UCS2|UTF16/.test(named);

  const widths = new Map<number, number>();
  const w = file.list(descendant?.get('W'));
  let budget = MAX_RANGE;
  for (let i = 0; i < w.length && budget > 0;) {
    const first = file.num(w[i]) ?? 0;
    const next = file.resolve(w[i + 1]);
    if (Array.isArray(next)) {
      next.forEach((v, j) => widths.set(first + j, file.num(v) ?? 0));
      budget -= next.length;
      i += 2;
      continue;
    }
    const width = file.num(w[i + 2]) ?? 0;
    for (let c = first; c <= (file.num(next) ?? first) && budget-- > 0; c++) widths.set(c, width);
    i += 3;
  }
  const fallback = file.num(descendant?.get('DW')) ?? 1000;
  const cid = (code: number): number => {
    for (const [lo, hi, start] of embedded?.cids ?? []) if (code >= lo && code <= hi) return start + code - lo;
    return code;
  };
  return {
    split: (bytes) => splitCodes(bytes, spaces),
    text: (code) => toUnicode?.unicode.get(code) ?? (unicodeCodes ? String.fromCharCode(code) : undefined),
    width: (code) => (widths.get(cid(code)) ?? fallback) / 1000,
  };
}

/** Type1, TrueType and Type3: one byte per code, read through the encoding. */
function simpleFont(file: PdfFile, dict: Dict, toUnicode: CMap | null): Font {
  const subtype = file.name(dict.get('Subtype'));
  const baseFont = file.name(dict.get('BaseFont')) ?? '';
  const encoding = file.resolve(dict.get('Encoding'));
  const named = encoding instanceof Name ? encoding.value : encoding instanceof Map ? file.name(encoding.get('BaseEncoding')) : undefined;
  const table = encodingTable(named ?? (subtype === 'Type1' && !/Symbol|Dingbats/.test(baseFont) ? 'StandardEncoding' : 'WinAnsiEncoding'));

  const differences = new Map<number, string>();
  if (encoding instanceof Map) {
    let code = 0;
    for (const item of file.list(encoding.get('Differences'))) {
      const v = file.resolve(item);
      if (typeof v === 'number') code = v;
      else if (v instanceof Name) differences.set(code++, glyphName(v.value));
    }
  }

  const first = file.num(dict.get('FirstChar')) ?? 0;
  const widths = file.list(dict.get('Widths')).map((v) => file.num(v) ?? 0);
  const missing = file.num(file.dict(dict.get('FontDescriptor'))?.get('MissingWidth'));
  // The standard fonts may leave their widths out; an average keeps word gaps roughly right.
  const fallback = widths.length ? missing ?? 0 : /Courier/i.test(baseFont) ? 600 : 500;
  const scale = subtype === 'Type3' ? Math.abs(file.num(file.list(dict.get('FontMatrix'))[0]) ?? 0.001) : 0.001;
  return {
    split: (bytes) => Array.from(bytes, (ch) => [ch.charCodeAt(0), 1] as [number, number]),
    text: (code) => {
      const mapped = toUnicode?.unicode.get(code);
      if (mapped !== undefined) return mapped;
      if (differences.has(code)) return differences.get(code) || undefined;
      return table[code] || undefined;
    },
    width: (code) => (widths[code - first] ?? fallback) * scale,
  };
}

const ENCODINGS = new Map<string, string[]>();

/** StandardEncoding above 0x7f, in runs starting at the given code. */
const STANDARD_HIGH: Array<[number, string]> = [
  [0xa1, '¡¢£⁄¥ƒ§¤\'“«‹›ﬁﬂ'], [0xb1, '–†‡·\0¶•‚„”»…‰\0¿'], [0xc1, '`´ˆ˜¯˘˙¨\0˚¸\0˝˛ˇ'], [0xd0, '—'],
  [0xe1, 'Æ\0ª'], [0xe8, 'ŁØŒº'], [0xf1, 'æ'], [0xf5, 'ı'], [0xf8, 'łøœß'],
];

function encodingTable(name: string): string[] {
  let table = ENCODINGS.get(name);
  if (table) return table;
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  let chars: string[];
  if (name === 'MacRomanEncoding') chars = [...new TextDecoder('macintosh').decode(all)];
  else if (name === 'StandardEncoding') {
    chars = Array.from(all, (c) => (c < 0x7f ? String.fromCharCode(c) : ''));
    chars[0x27] = '’';
    chars[0x60] = '‘';
    for (const [start, run] of STANDARD_HIGH) [...run].forEach((ch, i) => { chars[start + i] = ch === '\0' ? '' : ch; });
  } else chars = [...new TextDecoder('windows-1252').decode(all)];
  table = chars.map((ch) => (/^\p{Cc}$/u.test(ch) ? '' : ch));
  ENCODINGS.set(name, table);
  return table;
}

const ASCII_NAMES = ('space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma '
  + 'hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at '
  + 'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave '
  + 'a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde').split(' ');

const GLYPHS: Record<string, string> = {
  quoteright: '’', quoteleft: '‘', quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚', quotedblbase: '„',
  endash: '–', emdash: '—', bullet: '•', ellipsis: '…', dagger: '†', daggerdbl: '‡', periodcentered: '·',
  trademark: '™', copyright: '©', registered: '®', degree: '°', section: '§', paragraph: '¶', cent: '¢',
  sterling: '£', yen: '¥', Euro: '€', florin: 'ƒ', guillemotleft: '«', guillemotright: '»', guilsinglleft: '‹',
  guilsinglright: '›', exclamdown: '¡', questiondown: '¿', minus: '−', multiply: '×', divide: '÷', plusminus: '±',
  fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', dotlessi: 'ı', germandbls: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ',
  OE: 'Œ', oslash: 'ø', Oslash: 'Ø', lslash: 'ł', Lslash: 'Ł', eth: 'ð', Eth: 'Ð', thorn: 'þ', Thorn: 'Þ', mu: 'µ',
  nbspace: ' ', nonbreakingspace: ' ', onehalf: '½', onequarter: '¼', threequarters: '¾', ordfeminine: 'ª',
  ordmasculine: 'º', logicalnot: '¬', brokenbar: '¦', fraction: '⁄', perthousand: '‰', arrowright: '→', arrowleft: '←',
};

const ACCENTS: Record<string, string> = {
  acute: '\u0301', grave: '\u0300', circumflex: '\u0302', dieresis: '\u0308', tilde: '\u0303', ring: '\u030A',
  cedilla: '\u0327', caron: '\u030C', macron: '\u0304', breve: '\u0306', ogonek: '\u0328', dotaccent: '\u0307',
  hungarumlaut: '\u030B', commaaccent: '\u0326',
};

/** The text an Adobe glyph name stands for: "eacute" is é, "uni2022" is •, "f_i" is fi. */
function glyphName(full: string): string {
  const name = full.split('.')[0];
  if (name.includes('_')) return name.split('_').map(glyphName).join('');
  if (/^uni(?:[0-9A-Fa-f]{4})+$/.test(name)) return name.slice(3).match(/.{4}/g)!.map((h) => String.fromCharCode(parseInt(h, 16))).join('');
  if (/^u[0-9A-Fa-f]{4,6}$/.test(name)) return String.fromCodePoint(Math.min(parseInt(name.slice(1), 16), 0x10ffff));
  const ascii = ASCII_NAMES.indexOf(name);
  if (ascii >= 0) return String.fromCharCode(32 + ascii);
  if (GLYPHS[name]) return GLYPHS[name];
  const accented = /^([A-Za-z])([a-z]+)$/.exec(name);
  if (accented && ACCENTS[accented[2]]) return (accented[1] + ACCENTS[accented[2]]).normalize('NFC');
  return '';
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function translate(m: Matrix, x: number, y: number): Matrix {
  return [m[0], m[1], m[2], m[3], x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

interface GState { ctm: Matrix; font: Font; size: number; tc: number; tw: number; th: number; tl: number; rise: number }

/** Where a glyph landed: `u` along its baseline, `v` across it, both in page space. */
interface Glyph { text: string; u: number; v: number; end: number; size: number; angle: number }

/** A font a content stream names but the page does not define: read the bytes as Latin-1. */
const UNKNOWN_FONT: Font = {
  split: (bytes) => Array.from(bytes, (ch) => [ch.charCodeAt(0), 1] as [number, number]),
  text: (code) => encodingTable('WinAnsiEncoding')[code] || undefined,
  width: () => 0.5,
};

function startState(): GState {
  return { ctm: IDENTITY, font: UNKNOWN_FONT, size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
}

const MAX_GLYPHS = 2_000_000;

class Reader {
  readonly file: PdfFile;
  glyphs: Glyph[] = [];
  count = 0;
  unmapped = 0;
  readonly #fonts = new Map<Dict, Font>();
  readonly #active = new Set<Stream>();

  constructor(file: PdfFile) { this.file = file; }

  run(content: string, resources: Dict | undefined, start: GState, depth: number): void {
    const lx = new Lexer(content);
    const stack: GState[] = [];
    let gs: GState = { ...start };
    let tm = IDENTITY;
    let tlm = IDENTITY;
    let args: Value[] = [];
    // Marked content whose ActualText says what its glyphs spell, as LibreOffice writes for ligatures and spaces.
    const marked: Array<{ actual?: string; start: number }> = [];
    const num = (i: number): number => (typeof args[i] === 'number' ? args[i] as number : 0);
    const matrix = (): Matrix => [num(0), num(1), num(2), num(3), num(4), num(5)];
    const nextLine = (x: number, y: number): void => { tlm = translate(tlm, x, y); tm = tlm; };
    const show = (s: Value | undefined): void => {
      if (!(s instanceof PdfString)) return;
      for (const [code, len] of gs.font.split(s.bytes)) {
        if (this.count >= MAX_GLYPHS) return;
        const advance = (gs.font.width(code) * gs.size + gs.tc + (len === 1 && code === 32 ? gs.tw : 0)) * gs.th;
        this.#place(gs.font.text(code), mul(tm, gs.ctm), gs, advance);
        tm = translate(tm, advance, 0);
      }
    };

    const budget = this.file.budget;
    for (let t = lx.next(); t !== undefined; t = lx.next()) {
      budget.token();
      if (!(t instanceof Op)) {
        if (args.length < 64) args.push(t);
        continue;
      }
      switch (t.op) {
        case 'q': if (stack.length < 64) stack.push({ ...gs }); break;
        case 'Q': gs = stack.pop() ?? gs; break;
        case 'cm': gs.ctm = mul(matrix(), gs.ctm); break;
        case 'BT': tm = tlm = IDENTITY; break;
        case 'Tf': gs.font = this.#font(resources, args[0]); gs.size = num(1); break;
        case 'Tc': gs.tc = num(0); break;
        case 'Tw': gs.tw = num(0); break;
        case 'Tz': gs.th = num(0) / 100; break;
        case 'TL': gs.tl = num(0); break;
        case 'Ts': gs.rise = num(0); break;
        case 'Td': nextLine(num(0), num(1)); break;
        case 'TD': gs.tl = -num(1); nextLine(num(0), num(1)); break;
        case 'Tm': tm = tlm = matrix(); break;
        case 'T*': nextLine(0, -gs.tl); break;
        case 'Tj': show(args[0]); break;
        case '\'': nextLine(0, -gs.tl); show(args[0]); break;
        case '"': gs.tw = num(0); gs.tc = num(1); nextLine(0, -gs.tl); show(args[2]); break;
        case 'TJ':
          for (const item of Array.isArray(args[0]) ? args[0] : []) {
            if (typeof item === 'number') tm = translate(tm, (-item / 1000) * gs.size * gs.th, 0);
            else show(item);
          }
          break;
        case 'Do': this.#form(resources, args[0], gs, depth); break;
        case 'BMC': marked.push({ start: this.glyphs.length }); break;
        case 'BDC': {
          const props = args[1] instanceof Name ? this.file.dict(this.file.dict(resources?.get('Properties'))?.get(args[1].value)) : this.file.dict(args[1]);
          const actual = this.file.resolve(props?.get('ActualText'));
          const inside = marked.some((m) => m.actual !== undefined);
          marked.push({ start: this.glyphs.length, actual: actual instanceof PdfString && !inside ? textString(actual.bytes) : undefined });
          break;
        }
        case 'EMC': {
          const m = marked.pop();
          if (m?.actual !== undefined) this.#replace(m.start, m.actual);
          break;
        }
        case 'ID': {
          // Inline image data is binary and ends at the first EI on its own.
          const end = /\sEI(?![^\s])/g;
          end.lastIndex = lx.pos;
          const m = end.exec(content);
          lx.pos = m ? m.index + 3 : content.length;
          break;
        }
      }
      args = [];
    }
  }

  #font(resources: Dict | undefined, name: Value | undefined): Font {
    const dict = name instanceof Name ? this.file.dict(this.file.dict(resources?.get('Font'))?.get(name.value)) : undefined;
    if (!dict) return UNKNOWN_FONT;
    let font = this.#fonts.get(dict);
    if (!font) this.#fonts.set(dict, font = loadFont(this.file, dict));
    return font;
  }

  /** Text inside a form XObject, drawn where the form is placed. */
  #form(resources: Dict | undefined, name: Value | undefined, gs: GState, depth: number): void {
    if (!(name instanceof Name) || depth >= 8) return;
    const form = this.file.resolve(this.file.dict(resources?.get('XObject'))?.get(name.value));
    if (!(form instanceof Stream) || this.file.name(form.dict.get('Subtype')) !== 'Form' || this.#active.has(form)) return;
    this.file.budget.form();
    const m = this.file.list(form.dict.get('Matrix')).map((v) => this.file.num(v) ?? 0);
    this.#active.add(form);
    this.run(this.file.text(form), this.file.dict(form.dict.get('Resources')) ?? resources,
      { ...gs, ctm: m.length === 6 ? mul(m as Matrix, gs.ctm) : gs.ctm }, depth + 1);
    this.#active.delete(form);
  }

  /** The glyphs drawn since `start`, as one piece of text that says what they spell. */
  #replace(start: number, actual: string): void {
    const inner = this.glyphs.splice(start);
    if (!inner.length) return;
    this.unmapped -= inner.filter((g) => g.text === '\uFFFD').length;
    const end = inner.reduce((most, g) => (g.end > most ? g.end : most), -Infinity);
    this.glyphs.push({ ...inner[0], text: actual.replace(/\s/g, ' '), end });
  }

  #place(text: string | undefined, m: Matrix, gs: GState, advance: number): void {
    this.count++;
    if (text === undefined) {
      this.unmapped++;
      text = '\uFFFD';
    }
    // Chrome maps a space glyph to whatever character first used it, often a newline from the HTML source.
    text = text.replace(/\s/g, ' ').replace(/\p{Cc}/gu, '');
    const scale = Math.hypot(m[0], m[1]) || 1;
    const dx = m[0] / scale;
    const dy = m[1] / scale;
    const x = gs.rise * m[2] + m[4];
    const y = gs.rise * m[3] + m[5];
    const u = dx * x + dy * y;
    const size = Math.abs(gs.size * (dx * m[3] - dy * m[2]));
    if (!Number.isFinite(u + size)) return;
    this.glyphs.push({
      text, u, v: dx * y - dy * x, end: u + advance * scale, size: size || 1,
      angle: (Math.round(Math.atan2(dy, dx) / (Math.PI / 2)) + 4) % 4,
    });
  }
}

/** A gap wider than this share of the font size, beyond the line's letter spacing, is a space between words. */
const WORD_GAP = 0.2;
/** A gap wider than this many font sizes separates fields on one line, such as a title and its right-aligned date. */
const FIELD_GAP = 2;
/** A drop between baselines bigger than this many line heights starts a paragraph. */
const PARAGRAPH_DROP = 1.9;
/** A list marker on a line of its own. */
const MARKER = /^(?:[\p{Pd}\p{S}•◦▪▸▹‣·*]|\d{1,3}[.)]|[a-zA-Z][.)]|[ivxIVX]{1,4}[.)])$/u;

interface Line { glyphs: Glyph[]; v: number; u0: number; u1: number; size: number; angle: number; text: string }

/**
 * Glyphs into lines, in the order the page draws them. Generators draw in
 * reading order far more reliably than any geometric sort recovers it, and
 * Chrome draws in document order, so a sidebar stays a block of its own.
 */
function layout(glyphs: Glyph[]): string {
  const lines: Line[] = [];
  let line: Line | undefined;
  for (const g of glyphs) {
    if (!g.text) continue;
    const last = line?.glyphs[line.glyphs.length - 1];
    const size = last ? Math.min(g.size, last.size) : g.size;
    if (line && last && g.angle === line.angle && Math.abs(g.v - last.v) < size * 0.5 && g.u > last.end - size) {
      line.glyphs.push(g);
      line.u1 = Math.max(line.u1, g.end);
      line.size = Math.max(line.size, g.size);
    } else {
      line = { glyphs: [g], v: g.v, u0: g.u, u1: g.end, size: g.size, angle: g.angle, text: '' };
      lines.push(line);
    }
  }
  for (const l of lines) l.text = lineText(l.glyphs);

  // Chrome paints a list item's bullet after the item's text. Put it back in front.
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i];
    if (!MARKER.test(marker.text)) continue;
    for (let j = i - 1; j >= Math.max(0, i - 40); j--) {
      const item = lines[j];
      if (item.text && item.angle === marker.angle && Math.abs(item.v - marker.v) < Math.min(item.size, marker.size) * 0.5
        && marker.u1 <= item.u0 + marker.size * 0.5 && item.u0 - marker.u1 < marker.size * 3) {
        item.text = `${marker.text} ${item.text}`;
        item.u0 = marker.u0;
        marker.text = '';
        break;
      }
    }
  }

  const out: string[] = [];
  let prev: Line | undefined;
  for (const l of lines) {
    if (!l.text) continue;
    if (prev) {
      const drop = prev.v - l.v;
      const height = Math.max(prev.size, l.size);
      out.push(l.angle !== prev.angle || drop < -height || drop > height * PARAGRAPH_DROP ? '\n\n' : '\n');
    }
    out.push(l.text);
    prev = l;
  }
  return out.join('');
}

/**
 * One line's glyphs as text, with spaces where the gaps are wider than the
 * letters' own spacing. Letter-spaced headings set every glyph apart by the
 * same amount; measuring against the line's usual gap keeps them one word.
 */
function lineText(glyphs: Glyph[]): string {
  const gaps: number[] = [];
  for (let i = 1; i < glyphs.length; i++) {
    gaps.push((glyphs[i].u - glyphs[i - 1].end) / Math.min(glyphs[i].size, glyphs[i - 1].size));
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const tracking = gaps.length >= 5 ? Math.min(Math.max(sorted[Math.floor(sorted.length / 2)], 0), 0.6) : 0;
  let out = glyphs[0]?.text ?? '';
  for (let i = 1; i < glyphs.length; i++) {
    const text = glyphs[i].text;
    if (gaps[i - 1] > tracking + WORD_GAP && !/\s/.test(out[out.length - 1]) && !/^\s/.test(text)) out += gaps[i - 1] > FIELD_GAP ? '\t' : ' ';
    out += text;
  }
  return out;
}

function normalise(text: string): string {
  return text
    .replace(/[\uFB00-\uFB06]/g, (lig) => lig.normalize('NFKC'))
    // Private-use code points are icon glyphs: they carry no words.
    .replace(/[\uE000-\uF8FF\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/ *\t[ \t]*/g, '\t')
    .replace(/ {2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    // A word broken across lines at a hyphen reads as one again.
    .replace(/(\p{L})-\n(?=\p{Ll})/gu, '$1-')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * How much does this look like language?
 *
 * A font without a text mapping produces plausible-looking characters that
 * are not words, and indexing those silently poisons retrieval. Counting the
 * share of characters that belong in ordinary text is a crude but effective
 * check. Letters outside Latin-1 count as readable, so a résumé in Cyrillic or
 * Japanese is not refused for having no ASCII vowels.
 */
function scoreText(text: string): number {
  if (!text) return 0;
  const sample = [...text.slice(0, 4000)];
  const readable = sample.filter((ch) => /[A-Za-z0-9\s.,;:'"()\-@/&%$+•·–—|!?#*’‘“”]/.test(ch)
    || (ch.codePointAt(0)! > 0xff && ch !== '\uFFFD' && /[\p{L}\p{N}\p{P}]/u.test(ch))).length;
  const ratio = readable / sample.length;
  // Real prose has vowels in most words; glyph-code noise usually does not.
  const words = text.slice(0, 4000).split(/\s+/).filter((w) => /^[A-Za-z]{3,}$/.test(w)).slice(0, 200);
  if (words.length < 10) return ratio;
  const vowelly = words.filter((w) => /[aeiouyAEIOUY]/.test(w)).length;
  return Math.min(ratio, (vowelly / words.length) * 1.2);
}
