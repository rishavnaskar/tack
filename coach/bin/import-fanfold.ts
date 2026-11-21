// Copies a Fanfold profile into Tack: node --no-warnings coach/bin/import-fanfold.ts [fanfold-state-dir]
// Writes into TACK_STATE_DIR (or the repo's state/). Prints counts and field names, never the values.

import { importFanfold, defaultFanfoldDir } from '../src/fanfold-import.ts';
import { resumeText } from '../src/engine.ts';
import { stateDir } from '../src/store.ts';

const dir = process.argv[2] || defaultFanfoldDir();
const read = async (bytes: Buffer, mime: string) => {
  const r = await resumeText(bytes, mime);
  return r.ok ? r.text : '';
};
try {
  const s = await importFanfold(dir, { resumeText: read });
  console.log(`Imported from ${dir} into ${stateDir()}`);
  console.log(`  details: ${s.details.join(', ') || 'none'}`);
  console.log(`  profile: ${s.skills} skills with résumé quotes, ${s.roles} roles`);
  console.log(`  engine facts: ${s.facts.join(', ') || 'none'}`);
  console.log(`  answers: ${s.answers} of the person's own (${s.leftOut} written by an agent or unchecked, left out)`);
  console.log(`  résumé: ${s.resume ? 'imported' : 'none'}`);
  for (const w of s.warnings) console.log(`  note: ${w}`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
