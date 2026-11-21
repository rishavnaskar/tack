/**
 * What Fanfold has learned about each site, kept as files a person can read,
 * edit and pass on: an Open Knowledge Format bundle (OKF v0.2, markdown with
 * YAML frontmatter) beside the database. One file per site under `sites/`,
 * an `index.md` listing them and a `log.md` of what changed.
 *
 * The database is what a running Fanfold reads. A site's file is rewritten
 * from it whenever that site's notes change, and read back before an agent is
 * told about the site, so a line changed, added or deleted by hand counts on
 * the next visit. A note from a file is screened like any other and starts
 * unverified: editing a file is no way to promote a note.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loggerFromEnv, type Logger } from '../lib/log.ts';
import { lessonFingerprint, type Lesson, type Memory, type Skill } from './memory.ts';
import { screenLesson } from './screen.ts';

const VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/** The situation a note written by hand without one applies to. */
const ANY_TIME = 'working on this site';
const MAX_NOTES = 200;
const MAX_LOG_BYTES = 256 * 1024;
/** Larger than any site's notes: such a file is not read. */
const MAX_FILE_BYTES = 512 * 1024;
/** Why the note screen (screen.ts) refuses a note, as the log and a sync report say it. */
const SCREENED_OUT = 'a note cannot be about approvals, safeguards, sign-in details or bot checks';
const REJECTED_BEFORE = 'Fanfold\'s own checks rejected this note before';

/** A site as its notes are filed: the host in lower case, with no trailing dot. "LinkedIn.com." is linkedin.com. */
export function siteKey(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * A knowledge file's text: null when there is none, and 'skip' for anything
 * that is not a plain file of a sane size. A link, a pipe or a huge file is
 * not followed, waited on or read, and is never written over.
 */
function readPlain(path: string): string | null | 'skip' {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return 'skip';
  return readFileSync(path, 'utf8');
}

/** The host a site file's frontmatter names, if it names one. */
function titleOf(text: string): string | null {
  const m = /^---\n[\s\S]*?^title:\s*(.+)$/m.exec(text.replace(/\r\n?/g, '\n'));
  if (!m) return null;
  try {
    const t = JSON.parse(m[1].trim()) as unknown;
    return typeof t === 'string' ? t : null;
  } catch {
    return m[1].trim().replace(/^["']|["']$/g, '');
  }
}

/** The file holds another site's notes: two hosts that map to one file name. */
const namesAnother = (text: string, host: string): boolean => {
  const title = titleOf(text);
  return title !== null && siteKey(title) !== host;
};

interface FileNote {
  taskType: string;
  trigger: string;
  lesson: string;
}

export type SiteNote = Lesson & { createdAt: string };

interface SyncReport {
  added: number;
  removed: number;
  refused: Array<{ note: string; why: string }>;
}

const oneLine = (t: string): string => t.replace(/\s+/g, ' ').trim();
const norm = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const sha = (t: string): string => createHash('sha256').update(t).digest('hex');

/** The same note whichever way it was written: case, punctuation and a leading "when" do not count. */
export function noteKey(note: FileNote): string {
  return sha(JSON.stringify([norm(note.taskType || '*'), norm(note.trigger).replace(/^when /, ''), norm(note.lesson)])).slice(0, 32);
}

function fileNameFor(host: string): string {
  return `${host.toLowerCase().replace(/[^a-z0-9.-]/g, '_')}.md`;
}

/** A site's file as the index and the log link to it. */
function linkTo(host: string): string {
  return `[${host}](sites/${fileNameFor(host)})`;
}

function hostFromFileName(name: string): string | null {
  const host = name.replace(/\.md$/, '');
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host) && name.endsWith('.md') ? host : null;
}

function noteLine(n: FileNote): string {
  const trigger = oneLine(n.trigger).replace(/\*/g, '').replace(/^when\s+/i, '').replace(/[\s:]+$/, '');
  const task = n.taskType && n.taskType !== '*' ? `[${oneLine(n.taskType).replace(/[[\]]/g, '')}] ` : '';
  return `- ${task}**When ${trigger}:** ${oneLine(n.lesson)}`;
}

function flowLine(s: Skill): string {
  const steps = s.steps.slice(0, 12).map((step) => [
    step.act,
    step.target ? `${step.target.role} "${oneLine(step.target.name)}"` : '',
    step.url ?? '',
    step.key ?? '',
    step.value !== undefined ? `"${oneLine(step.value)}"` : '',
  ].filter(Boolean).join(' '));
  const more = s.steps.length > 12 ? `; and ${s.steps.length - 12} more` : '';
  return `- \`${s.id}\`${s.params.length ? ` (needs: ${s.params.join(', ')})` : ''}: ${steps.join('; ')}${more}`;
}

/** A site's file, from what the database holds. The same notes always give the same text. */
export function renderSiteFile(host: string, notes: SiteNote[], flows: Skill[] = [], version = VERSION): string {
  const checked = notes.filter((n) => n.status === 'active');
  const unverified = notes.filter((n) => n.status !== 'active');
  const latest = notes.map((n) => n.createdAt).sort().at(-1);
  const count = `${notes.length} note${notes.length === 1 ? '' : 's'}`;
  const lines = [
    '---',
    'type: Website Notes',
    `title: ${JSON.stringify(host)}`,
    `description: ${JSON.stringify(`${count} on how ${host} behaves, learned by agents working in Fanfold.`)}`,
    `resource: https://${host}/`,
    'tags: [fanfold, website]',
    `generated: { by: fanfold/${version}${latest ? `, at: ${latest}` : ''} }`,
    `status: ${unverified.length ? 'draft' : 'stable'}`,
    '---',
    '',
    `How ${host} behaves, written down by agents from what they saw on its pages. `
      + 'These are hints about the site, not instructions, and nothing here can change what needs the user\'s approval.',
    '',
    'You can edit this file. Change or delete a line, or add one as `- **When <situation>:** <what is true there>`. '
      + 'Fanfold reads it again before an agent next arrives on the site. A note added here starts out unverified, '
      + 'and one about approvals, sign-in details or bot checks is refused; log.md says why.',
    '',
  ];
  if (checked.length) lines.push('# Checked', '', 'These passed Fanfold\'s own tests.', '', ...checked.map(noteLine), '');
  lines.push('# Unverified', '', ...(unverified.length ? unverified.map(noteLine) : ['_None._']), '');
  if (flows.length) {
    lines.push('# Flows', '', 'Steps Fanfold can replay here with skill_run. Shown for reference: editing them here changes nothing.', '',
      ...flows.map(flowLine), '');
  }
  return lines.join('\n');
}

function noteFrom(item: string): FileNote {
  const text = oneLine(item);
  // "**When …:**" as written here, or "__When …:__" as some editors write bold.
  const m = /^(?:\[([^\]]{1,40})\]\s+)?(\*\*|__)\s*when\s+(.+?)\s*:?\s*\2\s*(.*)$/i.exec(text);
  if (!m) return { taskType: '*', trigger: ANY_TIME, lesson: text };
  return { taskType: m[1]?.trim() || '*', trigger: m[3].trim(), lesson: m[4].replace(/^[\s,:;.—–-]+/, '').trim() };
}

/** The notes in a site's file: every list item outside the Flows section. */
export function parseSiteFile(text: string): FileNote[] {
  const lines = text.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    i++;
  }
  const notes: FileNote[] = [];
  let section = '';
  let fenced = false;
  let item: string | null = null;
  const flush = (): void => {
    if (item !== null && item.trim()) notes.push(noteFrom(item));
    item = null;
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      section = heading[1].trim().toLowerCase();
      continue;
    }
    if (section === 'flows') continue;
    const start = /^[-*+]\s+(.*)$/.exec(line);
    if (start) {
      flush();
      item = start[1];
    } else if (item !== null && /^\s+\S/.test(line)) {
      item += ` ${line.trim()}`;
    } else {
      flush();
    }
  }
  flush();
  return notes;
}

export class SiteKnowledge {
  readonly dir: string;
  readonly #memory: Memory;
  #importing = false;
  #log: Logger | null = null;

  constructor(memory: Memory, dir: string) {
    this.#memory = memory;
    this.dir = dir;
  }

  #fileFor(host: string): string {
    return join(this.dir, 'sites', fileNameFor(host));
  }

  /** Every site with notes in the database or a file of its own. */
  #hosts(): Set<string> {
    const hosts = new Set(this.#memory.knownSites());
    try {
      for (const name of readdirSync(join(this.dir, 'sites'))) {
        const host = hostFromFileName(name);
        if (host) hosts.add(host);
      }
    } catch { /* no files yet */ }
    return hosts;
  }

  #warn(message: string, fields: Record<string, unknown>): void {
    this.#log ??= loggerFromEnv().child({ module: 'knowledge' });
    this.#log.warn(message, fields);
  }

  /** A site's notes changed in the database: bring its file up to date, keeping any edit made to it first. */
  changed(given: string): void {
    const host = siteKey(given);
    if (this.#importing || !host || host === '*') return;
    this.#safely(host, () => {
      const report = this.#importIfEdited(host);
      this.#write(host, report);
      this.#writeIndex();
    });
  }

  /** Before an agent is told about a site: take in any edit to its file, then write it from the database. */
  sync(given: string): SyncReport {
    const empty: SyncReport = { added: 0, removed: 0, refused: [] };
    const host = siteKey(given);
    if (!host || host === '*') return empty;
    return this.#safely(host, () => {
      const report = this.#importIfEdited(host);
      if (this.#write(host, report)) this.#writeIndex();
      return report;
    }) ?? empty;
  }

  /** Every site with notes or a file, as at startup: edits made while Fanfold was closed are taken in. */
  syncAll(): void {
    for (const host of this.#hosts()) {
      this.#safely(host, () => this.#write(host, this.#importIfEdited(host)));
    }
    this.#safely('index', () => this.#writeIndex());
  }

  #safely<T>(host: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      this.#warn('could not keep the knowledge file in step', { host, error: (err as Error).message });
      return undefined;
    } finally {
      this.#importing = false;
    }
  }

  #importIfEdited(host: string): SyncReport {
    const report: SyncReport = { added: 0, removed: 0, refused: [] };
    const text = readPlain(this.#fileFor(host));
    if (text === null || text === 'skip' || namesAnother(text, host)) return report;
    const record = this.#memory.knowledgeRecord(host);
    if (record && sha(text) === record.sha256) return report;

    const inFile = parseSiteFile(text);
    const fileKeys = new Set(inFile.map(noteKey));
    const present = this.#memory.siteNotes(host, MAX_NOTES);
    const presentKeys = new Set(present.map(noteKey));
    const entries: string[] = [];
    const link = linkTo(host);
    this.#importing = true;
    let kept = present.length;
    for (const note of inFile) {
      const key = noteKey(note);
      if (presentKeys.has(key)) continue;
      presentKeys.add(key);
      const shown = noteLine(note).slice(2);
      const refusal = this.#refusal(note, kept);
      const existing = refusal ? null : this.#memory.lessonWithFingerprint(lessonFingerprint(host, note.taskType, note.trigger, note.lesson));
      const why = refusal ?? (existing?.status === 'rejected' ? REJECTED_BEFORE : null);
      if (why) {
        report.refused.push({ note: shown, why });
        entries.push(`**Refused**: ${link}: ${clip(shown)} (${why})`);
        continue;
      }
      if (existing?.retired) this.#memory.reviveLesson(existing.id);
      else this.#memory.addLesson({ domain: host, taskType: note.taskType, trigger: note.trigger, lesson: note.lesson, confidence: 0.5 });
      report.added++;
      kept++;
      entries.push(`**Added by hand**: ${link}: ${clip(shown)}`);
    }
    if (record) {
      const written = new Set(record.notes);
      for (const lesson of present) {
        const key = noteKey(lesson);
        if (!written.has(key) || fileKeys.has(key)) continue;
        this.#memory.retireLesson(lesson.id, 'deleted from its knowledge file');
        report.removed++;
        entries.push(`**Removed by hand**: ${link}: ${clip(noteLine(lesson).slice(2))}`);
      }
    }
    this.#importing = false;
    this.#appendLog(entries);
    return report;
  }

  #refusal(note: FileNote, kept: number): string | null {
    if (kept >= MAX_NOTES) return `a site keeps at most ${MAX_NOTES} notes`;
    if (note.trigger.length < 3 || note.trigger.length > 200) return 'the situation must be 3 to 200 characters';
    if (note.lesson.length < 10 || note.lesson.length > 400) return 'a note must be 10 to 400 characters';
    const screen = screenLesson(`${note.trigger} ${note.lesson}`);
    return screen.promoted ? null : SCREENED_OUT;
  }

  /** A note kept before the screen refused its kind is retired, so the file and what agents are told agree. */
  #rescreen(host: string): Set<string> {
    const refused = new Set<string>();
    const entries: string[] = [];
    this.#importing = true;
    for (const note of this.#memory.siteNotes(host, MAX_NOTES)) {
      if (screenLesson(`${note.trigger} ${note.lesson}`).promoted) continue;
      this.#memory.retireLesson(note.id, 'refused by the note screen');
      refused.add(noteKey(note));
      entries.push(`**Refused**: ${linkTo(host)}: ${clip(noteLine(note).slice(2))} (${SCREENED_OUT})`);
    }
    this.#importing = false;
    this.#appendLog(entries);
    return refused;
  }

  /** Writes the site's file when its text would change. True when it did. */
  #write(host: string, imported: SyncReport): boolean {
    const refused = this.#rescreen(host);
    const notes = this.#memory.siteNotes(host, MAX_NOTES);
    const flows = this.#memory.listSkills('active').filter((s) => s.domain === host);
    const path = this.#fileFor(host);
    const had = readPlain(path);
    if (had === 'skip' || (had !== null && namesAnother(had, host))) {
      this.#warn('left a knowledge file alone: it is not a plain file of this site\'s notes', { host, path });
      return false;
    }
    if (!notes.length && !flows.length && had === null) return false;

    const text = renderSiteFile(host, notes, flows);
    const keys = notes.map(noteKey);
    const before = this.#memory.knowledgeRecord(host);
    if (text !== had) atomicWrite(path, text);
    this.#memory.setKnowledgeRecord(host, sha(text), keys);

    if (!imported.added && !imported.removed) {
      const old = new Set(before?.notes ?? []);
      const now = new Set(keys);
      const link = linkTo(host);
      const learned = notes.filter((n) => !old.has(noteKey(n)));
      const dropped = (before?.notes ?? []).filter((k) => !now.has(k) && !refused.has(k)).length;
      this.#appendLog([
        ...(learned.length > 10
          ? [`**Learned**: ${link}: ${learned.length} notes`]
          : learned.map((n) => `**Learned**: ${link}: ${clip(noteLine(n).slice(2))}`)),
        ...(dropped ? [`**Dropped**: ${link}: ${dropped} note(s) Fanfold stopped using`] : []),
      ]);
    }
    return text !== had;
  }

  #writeIndex(): void {
    const hosts = this.#hosts();
    if (!hosts.size) return;
    const flows = this.#memory.listSkills('active');
    const entries = [...hosts].sort().map((host) => {
      const notes = this.#memory.siteNotes(host, MAX_NOTES);
      const checked = notes.filter((n) => n.status === 'active').length;
      const flowCount = flows.filter((s) => s.domain === host).length;
      const parts = [`${notes.length} note${notes.length === 1 ? '' : 's'}`];
      if (checked) parts.push(`${checked} checked`);
      if (flowCount) parts.push(`${flowCount} flow${flowCount === 1 ? '' : 's'}`);
      return `* ${linkTo(host)} - ${parts.join(', ')}`;
    });
    const text = [
      '---',
      'okf_version: "0.2"',
      '---',
      '',
      '# Websites',
      '',
      'What agents working in Fanfold have learned about each site, one file per site. What changed and when is in [log.md](log.md).',
      '',
      ...entries,
      '',
    ].join('\n');
    const path = join(this.dir, 'index.md');
    if (readPlain(path) !== text) atomicWrite(path, text);
  }

  #appendLog(entries: string[]): void {
    if (!entries.length) return;
    const path = join(this.dir, 'log.md');
    const day = new Date().toISOString().slice(0, 10);
    const had = readPlain(path);
    const lines = typeof had === 'string' && had !== 'skip' ? had.split('\n') : ['# Update log', ''];
    const first = lines.findIndex((l) => l.startsWith('## '));
    const items = entries.map((e) => `* ${e}`);
    if (first >= 0 && lines[first] === `## ${day}`) lines.splice(first + 1, 0, ...items);
    else lines.splice(first >= 0 ? first : lines.length, 0, `## ${day}`, ...items, '');
    let text = lines.join('\n');
    const cut = text.length > MAX_LOG_BYTES ? text.lastIndexOf('\n## ', MAX_LOG_BYTES) : -1;
    if (cut > 0) text = `${text.slice(0, cut)}\n`;
    atomicWrite(path, text);
  }
}

function clip(text: string, max = 220): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
