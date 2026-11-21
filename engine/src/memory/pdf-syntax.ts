/** PDF syntax: the values a file is made of, and the tokens that spell them. */

export class Name {
  readonly value: string;
  constructor(value: string) { this.value = value; }
}

export class Ref {
  readonly num: number;
  constructor(num: number) { this.num = num; }
}

/** A string's bytes, one char per byte. */
export class PdfString {
  readonly bytes: string;
  constructor(bytes: string) { this.bytes = bytes; }
}

export class Op {
  readonly op: string;
  constructor(op: string) { this.op = op; }
}

export class Stream {
  readonly dict: Dict;
  readonly raw: Buffer;
  constructor(dict: Dict, raw: Buffer) { this.dict = dict; this.raw = raw; }
}

export type Dict = Map<string, Value>;
export type Value = number | boolean | null | Name | Ref | PdfString | Value[] | Dict | Stream;

function isSpace(c: number): boolean {
  return c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
}

function isDelimiter(c: number): boolean {
  return c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
const REF_AFTER = /^\s+(\d+)\s+R(?![^\s()<>[\]{}/%])/;

/** Tokens of PDF syntax: the same grammar serves objects, content streams and CMaps. */
export class Lexer {
  readonly src: string;
  pos: number;
  constructor(src: string, pos = 0) { this.src = src; this.pos = pos; }

  skipSpace(): void {
    const s = this.src;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (isSpace(c)) this.pos++;
      else if (c === 37) {
        while (this.pos < s.length && s.charCodeAt(this.pos) !== 10 && s.charCodeAt(this.pos) !== 13) this.pos++;
      } else return;
    }
  }

  next(): Value | Op | undefined {
    this.skipSpace();
    const s = this.src;
    if (this.pos >= s.length) return undefined;
    const c = s[this.pos];
    if (c === '(') return new PdfString(this.#literal());
    if (c === '<') {
      if (s[this.pos + 1] === '<') { this.pos += 2; return this.#dict(); }
      let end = s.indexOf('>', this.pos);
      if (end === -1) end = s.length;
      const hex = s.slice(this.pos + 1, end);
      this.pos = end + 1;
      return new PdfString(hexBytes(hex));
    }
    if (c === '>' && s[this.pos + 1] === '>') { this.pos += 2; return new Op('>>'); }
    if (c === '[') { this.pos++; return this.#array(); }
    if (c === '/') {
      const start = ++this.pos;
      this.#word();
      const raw = s.slice(start, this.pos);
      return new Name(raw.includes('#') ? raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) : raw);
    }
    if (isDelimiter(s.charCodeAt(this.pos))) { this.pos++; return new Op(c); }
    const start = this.pos;
    this.#word();
    const word = s.slice(start, this.pos);
    if (/^[+\-.\d]+$/.test(word)) {
      const n = Number.parseFloat(word.replace(/^[+-]+(?=[+-])/, ''));
      if (/^\d+$/.test(word)) {
        const ref = REF_AFTER.exec(s.slice(this.pos, this.pos + 24));
        if (ref) { this.pos += ref[0].length; return new Ref(n); }
      }
      return Number.isFinite(n) ? n : 0;
    }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new Op(word);
  }

  #word(): void {
    const s = this.src;
    while (this.pos < s.length && !isSpace(s.charCodeAt(this.pos)) && !isDelimiter(s.charCodeAt(this.pos))) this.pos++;
  }

  #literal(): string {
    const s = this.src;
    let i = this.pos + 1;
    let depth = 1;
    let out = '';
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\') {
        const e = s[i + 1];
        if (e >= '0' && e <= '7') {
          let j = i + 1;
          let v = 0;
          while (j < i + 4 && s[j] >= '0' && s[j] <= '7') v = v * 8 + s.charCodeAt(j++) - 48;
          out += String.fromCharCode(v & 0xff);
          i = j;
        } else if (e === '\r') i += s[i + 2] === '\n' ? 3 : 2;
        else if (e === '\n') i += 2;
        else { out += ESCAPES[e] ?? e ?? ''; i += 2; }
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) { this.pos = i + 1; return out; }
      out += ch;
      i++;
    }
    this.pos = i;
    return out;
  }

  #array(): Value[] {
    const out: Value[] = [];
    for (let t = this.next(); t !== undefined; t = this.next()) {
      if (!(t instanceof Op)) out.push(t);
      else if (t.op === ']' || t.op === 'endobj') break;
    }
    return out;
  }

  #dict(): Dict {
    const out: Dict = new Map();
    for (;;) {
      const key = this.next();
      if (key === undefined) return out;
      if (key instanceof Op) {
        if (key.op === 'stream') this.pos -= 6;
        if (key.op === '>>' || key.op === 'endobj' || key.op === 'stream') return out;
        continue;
      }
      if (!(key instanceof Name)) continue;
      const value = this.next();
      if (value === undefined || (value instanceof Op && value.op === '>>')) return out;
      if (!(value instanceof Op)) out.set(key.value, value);
    }
  }
}

export function hexBytes(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let i = 0; i < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2).padEnd(2, '0'), 16));
  return out;
}

export function bytesToInt(bytes: string): number {
  let v = 0;
  for (let i = 0; i < bytes.length; i++) v = v * 256 + bytes.charCodeAt(i);
  return v;
}
