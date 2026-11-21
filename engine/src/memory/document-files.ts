/** Where the app's own copies of imported files are kept, and what they are called. */
import { rmSync, statSync } from 'node:fs';
import { extname } from 'node:path';

/** Ephemeral document directories created by in-memory databases in this process. */
export const ephemeralDirs = new Set<string>();
process.once('exit', () => {
  for (const dir of ephemeralDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort on the way out */ }
  }
});

/**
 * An extension for the retained copy.
 *
 * Taken from the title or the declared type, and restricted to a short
 * allow-list: the title is user-supplied, and "resume.pdf/../../.zshrc" must
 * not be able to steer where the file lands or what it is called.
 */
export function safeFilename(title: string, mime?: string): string {
  // The title is user-supplied and becomes a real path, so it is reduced to a
  // single harmless segment: no separators, no traversal, no control
  // characters, and a bounded length.
  const base = title
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .trim()
    .slice(0, 80);
  const ext = extensionFor(title, mime);
  if (!base) return `document${ext}`;
  return base.toLowerCase().endsWith(ext) ? base : base + ext;
}

function extensionFor(title: string, mime?: string): string {
  const byMime: Record<string, string> = {
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
  };
  if (mime && byMime[mime]) return byMime[mime];
  const ext = extname(title).toLowerCase();
  return /^\.(pdf|txt|md|markdown|rtf|doc|docx)$/.test(ext) ? ext : '.bin';
}

export function sizeOf(path: string): number | null {
  try { return statSync(path).size; } catch { return null; }
}
