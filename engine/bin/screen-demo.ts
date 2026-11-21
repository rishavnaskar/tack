/**
 * Resume-backed job screening, with the real model.
 *
 * The question this answers is narrow and matters: when a person asks the
 * agent to judge roles "given my resume", does their resume actually reach
 * the model, and does the answer show it was read? A retrieval layer that is
 * tested against its own unit tests and never against a whole run is the
 * kind of thing that quietly does nothing in production.
 *
 * The resume is the fixture PDF, imported through the same extraction the
 * chat UI uses. The job board is a faithful fake of a listing page (the
 * environment this was built in kills a headless Chrome in about a second,
 * see learn-cycle.ts); every decision and the final answer are the real model.
 *
 *   npm run screen:demo
 */

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ModelClient, apiKeyFromEnv } from '../src/model/client.ts';
import { Store } from '../src/store/db.ts';
import { Memory } from '../src/memory/memory.ts';
import { extractPdfText } from '../src/memory/pdf.ts';
import { runTask, type AgentEvent } from '../src/agent/loop.ts';
import { FakeRuntime, type FakePage } from '../test/fakes.ts';
import { loadEnv } from '../src/lib/env.ts';

loadEnv();

const say = (s = ''): void => { process.stdout.write(s + '\n'); };

// A listing with four roles. Two fit the fixture resume (TypeScript, Chrome
// DevTools Protocol, agentic systems), two plainly do not.
const BOARD: Record<string, FakePage> = {
  list: {
    url: 'https://jobs.example/search?q=engineer', title: 'Open roles',
    nodes: [
      { ref: 'e1', role: 'heading', name: '4 open roles', state: { level: 1 } },
      { ref: 'e2', role: 'link', name: 'Forward Deployed Engineer — Acme AI',
        evidence: { href: '/job/1', scheme: 'https', sameOrigin: true } },
      { ref: '', role: 'text', text: 'Build agentic workflows for enterprise customers. TypeScript, LangGraph, Postgres. Remote.' },
      { ref: 'e3', role: 'link', name: 'Browser Automation Engineer — Globex',
        evidence: { href: '/job/2', scheme: 'https', sameOrigin: true } },
      { ref: '', role: 'text', text: 'Own a Chrome DevTools Protocol driver used by thousands of QA teams. TypeScript, Node.' },
      { ref: 'e4', role: 'link', name: 'Senior Embedded Firmware Engineer — Initech',
        evidence: { href: '/job/3', scheme: 'https', sameOrigin: true } },
      { ref: '', role: 'text', text: 'Bare-metal C on ARM Cortex-M for industrial sensors. On-site, Stuttgart.' },
      { ref: 'e5', role: 'link', name: 'Staff iOS Engineer — Hooli',
        evidence: { href: '/job/4', scheme: 'https', sameOrigin: true } },
      { ref: '', role: 'text', text: 'Swift and SwiftUI; ten years shipping consumer apps at scale.' },
    ],
  },
};

const GOAL = 'Which of these jobs should I apply to, given my resume? Rank them and say why in one line each.';

const db = new DatabaseSync(':memory:');
const store = new Store(db);
const memory = new Memory(db);
const model = new ModelClient({ apiKey: apiKeyFromEnv() });

// Import the resume the way the UI does: real PDF, real extraction.
const pdf = readFileSync(new URL('../test/fixtures/resume.pdf', import.meta.url));
const extracted = extractPdfText(pdf);
const docId = memory.addDocument({ title: 'resume.pdf', text: extracted.text, mime: 'application/pdf', bytes: pdf });
say(`Imported resume.pdf: ${extracted.text.length} chars extracted (confidence ${extracted.confidence}), id ${docId.slice(0, 8)}`);
say(`  "${extracted.text.replace(/\s+/g, ' ').slice(0, 160)}…"`);
say();

const events: AgentEvent[] = [];
const page = new FakeRuntime(BOARD, 'list');
await page.goto(BOARD.list.url);
const before = model.totalCostUsd();
const result = await runTask({
  goal: GOAL, page, model, store, memory, maxSteps: 6, taskType: '*',
  onEvent: (e) => events.push(e),
});

const used = events.find((e) => e.type === 'documents_used') as { titles?: string[] } | undefined;
say('Run');
say(`  status: ${result.status} in ${result.steps} step(s), $${(model.totalCostUsd() - before).toFixed(5)}`);
say(`  documents reached the model: ${used ? used.titles!.join(', ') : 'NONE'}`);
say(`  answer:`);
for (const line of result.message.split('\n')) say(`    ${line}`);
say();

// The judgement, stated as checks rather than as a feeling about the answer.
const answer = result.message.toLowerCase();
const mentionsFit = /typescript|devtools|langgraph|agentic|postgres|forward deployed/.test(answer);
const ranksMisfitsLow = /firmware|ios|swift|embedded/.test(answer);
say('Checks');
say(`  [${used ? 'x' : ' '}] the resume was retrieved for this goal`);
say(`  [${mentionsFit ? 'x' : ' '}] the answer reasons from the resume's actual skills`);
say(`  [${ranksMisfitsLow ? 'x' : ' '}] the answer addresses the roles that do not fit`);
say(`  [${result.status === 'done' ? 'x' : ' '}] the run finished on its own`);

store.close();
