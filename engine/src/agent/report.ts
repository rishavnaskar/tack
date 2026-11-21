/**
 * What the agent collected, as a file.
 *
 * A long collecting run ends with dozens of rows that exist only in the
 * database and in a paragraph of chat. This writes them out once the
 * objective is met, so the result is something to keep, open and send on
 * rather than something to scroll back to.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactDir } from '../daemon/protocol.ts';
import type { Finding, Objective } from './objective.ts';

export interface Report {
  /** Absolute path on disk. */
  path: string;
  /** Name only, for showing and for the download URL. */
  name: string;
  rows: number;
}

/** A filename from the goal: readable, lowercase, no surprises for a shell. */
export function reportName(goal: string, at = new Date()): string {
  const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
    || 'findings';
  const day = at.toISOString().slice(0, 10);
  return `${slug}-${day}.md`;
}

export function renderReport(objective: Objective, findings: Finding[], at = new Date()): string {
  const what = objective.what ?? 'results';
  const lines = [
    `# ${objective.goal}`,
    '',
    `${findings.length} ${what}, collected ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    '',
  ];

  for (const [i, f] of findings.entries()) {
    const url = typeof f.data.url === 'string' ? f.data.url : '';
    const detail = typeof f.data.detail === 'string' ? f.data.detail : '';
    lines.push(`${i + 1}. ${url ? `[${escapeMd(f.label)}](${url})` : escapeMd(f.label)}`);
    if (detail) lines.push(`   ${escapeMd(detail)}`);
  }

  // Where each one came from, kept out of the list so it stays readable.
  const sources = [...new Set(findings.map((f) => f.sourceUrl).filter((s) => s && /^https?:/.test(s)))] as string[];
  if (sources.length) {
    lines.push('', '## Sources', '');
    for (const s of sources) lines.push(`- ${s}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Brackets and pipes are the only characters that change meaning in a list. */
function escapeMd(text: string): string {
  return text.replace(/([[\]|])/g, '\\$1');
}

export async function writeReport(
  objective: Objective, findings: Finding[], dir = artifactDir(), at = new Date(),
): Promise<Report> {
  const name = reportName(objective.goal, at);
  const path = join(dir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path, renderReport(objective, findings, at), 'utf8');
  return { path, name, rows: findings.length };
}
