// Tack as an MCP server over stdio: newline-delimited JSON-RPC 2.0.
// Runs in-process against the same store and route handlers as the HTTP server.
// Usage: node --no-warnings coach/bin/mcp.ts

import { createInterface } from 'node:readline';
import type { Ctx, Handler, Router } from '../src/server.ts';
import type { GapMap, GapSkill, InterviewSession, InterviewTurn, Kit, Plan, Posting, Progress, TrackerInsights } from '../src/types.ts';

// stdout carries protocol messages only; anything a module logs goes to stderr.
console.log = console.info = console.debug = console.error;

const { loadEnv } = await import('../src/llm.ts');
loadEnv();
const store = await import('../src/store.ts');
const { mount: mountA, state } = await import('../src/routes/a.ts');
const { mount: mountB } = await import('../src/routes/b.ts');
const { currentWeek, localDate } = await import('../src/plan.ts');
const { kitText } = await import('../src/kit.ts');

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'tack', title: 'Tack career pivot coach', version: '0.1.0' };

// ---- in-process router over the HTTP handlers ----

type Route = { method: string; parts: string[]; handler: Handler };
const routes: Route[] = [];
const parts = (path: string) => path.replace(/^\/?api(?=\/|$)/, '').split('/').filter(Boolean);
const add = (method: string) => (path: string, handler: Handler) => { routes.push({ method, parts: parts(path), handler }); };
const router: Router = { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') };
mountA(router);
mountB(router);

async function api<T>(method: string, path: string, body: unknown = {}, query = ''): Promise<T> {
  const want = parts(path);
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== want.length) continue;
    const params: Record<string, string> = {};
    if (!r.parts.every((p, i) => (p.startsWith(':') ? ((params[p.slice(1)] = decodeURIComponent(want[i])), true) : p === want[i]))) continue;
    return (await r.handler({ params, query: new URLSearchParams(query), body } as unknown as Ctx)) as T;
  }
  throw new Error(`no route for ${method} ${path}`);
}

// ---- text formatting ----

const pct = (x: number) => `${Math.round(x * 100)}%`;
const quote = (s: string) => `"${s}"`;
const today = () => localDate(new Date());
const levelText = (s: GapSkill) => `${s.level}, have ${s.have} of ${s.need}`;

function need<T>(v: T | undefined | null, message: string): T {
  if (v === undefined || v === null) throw new Error(message);
  return v;
}

async function stateText(): Promise<string> {
  const s = await state();
  const gap = store.get<GapMap>('single', 'gap');
  const plan = store.get<Plan>('single', 'plan');
  const out: string[] = [];
  if (s.profile) out.push(`${s.profile.name}: ${s.profile.currentRole || s.profile.headline}, ${s.profile.yearsExperience} years`);
  else out.push('No résumé yet. Add one in the Tack app, or load the demo person there.');
  if (s.goal) {
    const week = plan ? ` (week ${currentWeek(plan, today())} now)` : '';
    out.push(`Goal: ${s.goal.targetRole}${s.goal.location ? ` in ${s.goal.location}` : ''}${s.goal.remote ? ' or remote' : ''}, ${s.goal.hoursPerWeek} h a week for ${s.goal.weeks} weeks from ${s.goal.startDate}${week}`);
  }
  if (gap) out.push(`Readiness: ${gap.readiness}/100 against ${gap.postingCount} postings; ${gap.skills.filter((x) => x.level !== 'strong' && x.status !== 'closed').length} skills still open`);
  else out.push(`Postings read: ${s.counts.postings}; no gap map yet`);
  if (plan) {
    const p = await api<Progress>('GET', '/progress');
    out.push(`Plan v${plan.version}: ${p.tasksDone} of ${p.tasksTotal} tasks done, ${p.hoursDone} of ${p.hoursPlanned} h; ${p.onTrack ? 'on track' : 'behind'}. ${p.note}`);
  }
  if (s.counts.applications) {
    const ins = await api<TrackerInsights>('GET', '/tracker/insights');
    out.push(`Applications: ${ins.overall.sent} sent, ${ins.overall.responses} responses (${pct(ins.overall.rate)})`);
  }
  if (s.counts.interviews) {
    const done = (await api<InterviewSession[]>('GET', '/interviews')).filter((x) => x.score != null);
    out.push(`Mock interviews: ${s.counts.interviews}${done.length ? `, last score ${done[done.length - 1].score}/100` : ''}`);
  }
  out.push(`Mode: ${s.mode}; model ${s.model.configured ? s.model.name : 'not configured (built-in wording)'}; engine ${s.engine.available ? 'attached' : 'off'}`);
  return out.join('\n');
}

function gapText(limit: number): string {
  const gap = need(store.get<GapMap>('single', 'gap'), 'No gap map yet. Read the market and build the gap map in the Tack app first.');
  const open = gap.skills.filter((s) => s.level !== 'strong' && s.status !== 'closed').sort((a, b) => b.priority - a.priority).slice(0, limit);
  const out = [`Readiness ${gap.readiness}/100 from ${gap.postingCount} postings. Top ${open.length} open skills by priority:`];
  open.forEach((s, i) => {
    out.push('', `${i + 1}. ${s.name} (${s.id}): ${levelText(s)}; asked by ${pct(s.demand)} of postings, ${pct(s.mustShare)} of those as a must; priority ${s.priority}; ${s.status}`);
    out.push(s.evidence.resume.length ? `   Résumé: ${s.evidence.resume.slice(0, 2).map(quote).join('; ')}` : '   Résumé: nothing yet');
    for (const q of s.evidence.postings.slice(0, 2)) out.push(`   ${q.company}: ${quote(q.quote)}`);
    if (s.bridge) out.push(`   Bridge from ${s.bridge.from}: ${s.bridge.note}`);
  });
  if (!open.length) out.push('Every skill the postings ask for is covered.');
  return out.join('\n');
}

function weekText(plan: Plan, index: number): string {
  const week = need(plan.weeks.find((w) => w.index === index), `No week ${index}; the plan has ${plan.weeks.length} weeks.`);
  const names = new Map((store.get<GapMap>('single', 'gap')?.skills ?? []).map((s) => [s.id, s.name]));
  const done = week.tasks.filter((t) => t.status === 'done').reduce((a, t) => a + t.hours, 0);
  const now = currentWeek(plan, today());
  const out = [`Week ${week.index} of ${plan.weeks.length}${week.index === now ? ' (this week)' : ''}, from ${week.startDate}: ${week.theme}. ${done} of ${week.hours} h done.`];
  for (const t of week.tasks) {
    const mark = t.status === 'done' ? '[x]' : t.status === 'skipped' ? '[-]' : '[ ]';
    const skills = t.skillIds.map((id) => names.get(id) ?? id).join(', ');
    out.push(`${mark} ${t.id}: ${t.title} (${t.kind}, ${t.hours} h${skills ? `; ${skills}` : ''})${t.resource ? `\n    ${t.resource.title}: ${t.resource.url}` : ''}`);
  }
  const passed = week.checkpoint.passed === true ? 'passed' : week.checkpoint.passed === false ? 'not passed' : 'not checked yet';
  out.push(`Checkpoint (${passed}): ${week.checkpoint.title}. ${week.checkpoint.description}`);
  return out.join('\n');
}

function turnText(turn: InterviewTurn): string {
  const out = [`Overall ${turn.overall}/100`];
  for (const s of turn.scores) out.push(`- ${s.criterion} ${s.score}/5: ${s.why}${s.quote ? ` ${quote(s.quote)}` : ''}`);
  if (turn.strengths.length) out.push('', 'Strengths:', ...turn.strengths.map((x) => `- ${x}`));
  if (turn.fixes.length) out.push('', 'Fix next time:', ...turn.fixes.map((x) => `- ${x}`));
  out.push('', 'A stronger version, using only what you said:', turn.betterAnswer);
  if (turn.followUp) out.push('', `Follow-up an interviewer might ask: ${turn.followUp}`);
  return out.join('\n');
}

function nextQuestion(session: InterviewSession): string {
  const answered = new Set(session.turns.map((t) => t.questionId));
  const i = session.questions.findIndex((q) => !answered.has(q.id));
  if (i < 0) return `Session ${session.id} is finished: ${session.score ?? '-'}/100 across ${session.turns.length} answers.`;
  const q = session.questions[i];
  return [
    `Session ${session.id} (${session.kind}), question ${i + 1} of ${session.questions.length} [${q.id}, ${q.kind}]:`,
    q.text,
    '',
    `Answer with tack_interview_answer, sessionId "${session.id}", questionId "${q.id}".`,
  ].join('\n');
}

// ---- tools ----

type Args = Record<string, unknown>;
interface Tool {
  name: string; title: string; description: string; inputSchema: object;
  annotations?: Record<string, boolean | string>;
  run(args: Args): Promise<string> | string;
}

const int = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return v === undefined || v === null || !Number.isFinite(n) ? fallback : Math.min(hi, Math.max(lo, Math.round(n)));
};
const text = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} is required`);
  return v.trim();
};
const KINDS = ['behavioural', 'technical', 'case', 'mixed'];

const TOOLS: Tool[] = [
  {
    name: 'tack_state',
    title: 'Where things stand',
    description: 'The person, their target role, readiness, plan progress, applications and interviews in a few lines.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: () => stateText(),
  },
  {
    name: 'tack_gap',
    title: 'Biggest skill gaps',
    description: 'The open skills with the highest priority (demand times the gap), each with résumé evidence, posting quotes and any bridge from an existing skill.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many skills, default 5' } } },
    annotations: { readOnlyHint: true },
    run: (a) => gapText(int(a.limit, 1, 20, 5)),
  },
  {
    name: 'tack_plan_week',
    title: 'A week of the plan',
    description: "One week's tasks with ids, hours, status and the checkpoint. Defaults to the current week.",
    inputSchema: { type: 'object', properties: { week: { type: 'integer', minimum: 1, description: 'Week number, default this week' } } },
    annotations: { readOnlyHint: true },
    run: (a) => {
      const plan = need(store.get<Plan>('single', 'plan'), 'No plan yet. Build one in the Tack app first.');
      return weekText(plan, int(a.week, 1, plan.weeks.length, currentWeek(plan, today())));
    },
  },
  {
    name: 'tack_complete_task',
    title: 'Tick off a plan task',
    description: 'Marks a plan task done (or back to todo, or skipped). Progress, skill status and readiness update as in the app.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task id from tack_plan_week' }, status: { type: 'string', enum: ['done', 'todo', 'skipped'], description: 'Default done' } },
      required: ['taskId'],
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
    run: async (a) => {
      const id = text(a.taskId, 'taskId');
      const status = typeof a.status === 'string' ? a.status : 'done';
      const before = new Map((store.get<GapMap>('single', 'gap')?.skills ?? []).map((s) => [s.id, s.status]));
      const { plan, progress } = await api<{ plan: Plan; progress: Progress }>('PATCH', `/plan/tasks/${encodeURIComponent(id)}`, { status });
      const week = plan.weeks.find((w) => w.tasks.some((t) => t.id === id))!;
      const task = week.tasks.find((t) => t.id === id)!;
      const gap = store.get<GapMap>('single', 'gap');
      const moved = (gap?.skills ?? []).filter((s) => before.has(s.id) && before.get(s.id) !== s.status).map((s) => `${s.name} is now ${s.status}`);
      return [
        `Marked ${id} ${status}: ${task.title}`,
        `Week ${week.index}: ${week.tasks.filter((t) => t.status === 'done').length} of ${week.tasks.length} tasks done.`,
        `Overall: ${progress.tasksDone} of ${progress.tasksTotal} tasks, ${progress.hoursDone} of ${progress.hoursPlanned} h; ${progress.onTrack ? 'on track' : 'behind'}.${gap ? ` Readiness ${gap.readiness}/100.` : ''}`,
        ...moved,
      ].join('\n');
    },
  },
  {
    name: 'tack_next_applications',
    title: 'Where to apply next',
    description: 'Postings not applied to yet, ranked by fit and by how often that kind of role has replied so far, each with the reason.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 5' } } },
    annotations: { readOnlyHint: true },
    run: async (a) => {
      const ins = await api<TrackerInsights>('GET', '/tracker/insights');
      const list = ins.next.slice(0, int(a.limit, 1, 20, 5));
      if (!list.length) return 'No postings left to rank. Read the market again in the Tack app for fresh ones.';
      const out = [ins.overall.sent ? `Reply rate so far: ${pct(ins.overall.rate)} (${ins.overall.responses} of ${ins.overall.sent}).` : 'No applications logged yet, so the ranking is by fit.'];
      list.forEach((n, i) => out.push('', `${i + 1}. ${n.title} at ${n.company} [${n.postingId}]: fit ${n.fit}, reply chance ${pct(n.responseChance)}`, `   ${n.why}`, `   ${n.url}`));
      out.push('', 'tack_prepare_application with a posting id builds the application kit.');
      return out.join('\n');
    },
  },
  {
    name: 'tack_prepare_application',
    title: 'Prepare an application',
    description: 'The application kit for one posting: tailored headline, résumé bullets each tied to a real résumé line, cover note, talking points, gaps to address and questions to ask. Cached; pass fresh to rebuild.',
    inputSchema: {
      type: 'object',
      properties: { postingId: { type: 'string', description: 'Posting id, e.g. from tack_next_applications' }, fresh: { type: 'boolean', description: 'Rebuild instead of returning the cached kit' } },
      required: ['postingId'],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
    run: async (a) => {
      const id = text(a.postingId, 'postingId');
      const kit = await api<Kit>('POST', `/kit/${encodeURIComponent(id)}`, {}, a.fresh === true ? 'fresh=1' : '');
      return kitText(kit, store.get<Posting>('posting', id));
    },
  },
  {
    name: 'tack_interview_question',
    title: 'Get an interview question',
    description: 'Starts a mock interview (five questions from the target postings and open gaps) and returns the first question, or with sessionId returns the next unanswered one.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Continue this session' },
        kind: { type: 'string', enum: KINDS, description: 'For a new session, default mixed' },
        postingId: { type: 'string', description: 'For a new session: ask about this posting' },
      },
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
    run: async (a) => {
      if (typeof a.sessionId === 'string' && a.sessionId.trim()) {
        return nextQuestion(need(store.get<InterviewSession>('interview', a.sessionId.trim()), `No interview ${a.sessionId}`));
      }
      const kind = typeof a.kind === 'string' && KINDS.includes(a.kind) ? a.kind : 'mixed';
      const session = await api<InterviewSession>('POST', '/interviews', { kind, ...(typeof a.postingId === 'string' && a.postingId ? { postingId: a.postingId } : {}) });
      return nextQuestion(session);
    },
  },
  {
    name: 'tack_interview_answer',
    title: 'Answer an interview question',
    description: 'Scores an answer on the five-criterion rubric and returns the feedback, a stronger version built only from what was said, the follow-up probe, and the next question.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        questionId: { type: 'string', description: 'Default: the next unanswered question' },
        answer: { type: 'string', description: 'The answer, as said out loud' },
      },
      required: ['sessionId', 'answer'],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
    run: async (a) => {
      const sessionId = text(a.sessionId, 'sessionId');
      const session = need(store.get<InterviewSession>('interview', sessionId), `No interview ${sessionId}`);
      const answered = new Set(session.turns.map((t) => t.questionId));
      const questionId = typeof a.questionId === 'string' && a.questionId ? a.questionId : session.questions.find((q) => !answered.has(q.id))?.id;
      if (!questionId) throw new Error(`Session ${sessionId} is finished; start a new one with tack_interview_question.`);
      const res = await api<{ turn: InterviewTurn; session: InterviewSession }>('POST', `/interviews/${encodeURIComponent(sessionId)}/answer`, { questionId, answer: text(a.answer, 'answer') });
      return `${turnText(res.turn)}\n\n${nextQuestion(res.session)}`;
    },
  },
];

// ---- JSON-RPC over stdio ----

type Id = string | number | null;
interface Message { jsonrpc?: string; id?: Id; method?: string; params?: any }

const send = (msg: object) => { process.stdout.write(`${JSON.stringify(msg)}\n`); };
const reply = (id: Id, result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

function describe(t: Tool, version: string) {
  // Titles and annotations arrived in later protocol versions.
  const base = { name: t.name, description: t.description, inputSchema: t.inputSchema };
  if (version === '2024-11-05') return base;
  if (version === '2025-03-26') return { ...base, annotations: { title: t.title, ...t.annotations } };
  return { ...base, title: t.title, annotations: t.annotations };
}

let version = VERSIONS[0];

async function handle(m: Message): Promise<object | undefined> {
  if (!m || typeof m !== 'object') return fail(null, -32600, 'invalid request');
  const isRequest = m.id !== undefined && m.id !== null;
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
    // Replies to requests we never send are ignored; anything else is malformed.
    return 'result' in m || 'error' in m ? undefined : fail(m.id ?? null, -32600, 'invalid request');
  }
  if (!isRequest) return undefined; // notifications: initialized, cancelled, ...
  const id = m.id as Id;
  switch (m.method) {
    case 'initialize': {
      const asked = m.params?.protocolVersion;
      version = typeof asked === 'string' && VERSIONS.includes(asked) ? asked : VERSIONS[0];
      return reply(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: version === '2025-06-18' ? SERVER : { name: SERVER.name, version: SERVER.version },
        instructions: 'Tack is a career pivot coach. Start with tack_state, then tack_gap or tack_plan_week. Results are short plain text.',
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map((t) => describe(t, version)) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return fail(id, -32602, `unknown tool: ${m.params?.name}`);
      try {
        const out = await tool.run((m.params?.arguments ?? {}) as Args);
        return reply(id, { content: [{ type: 'text', text: out }], isError: false });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: (e as Error).message || 'failed' }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `method not found: ${m.method}`);
  }
}

const pending = new Set<Promise<void>>();

function onLine(line: string): void {
  if (!line.trim()) return;
  let msg: unknown;
  try { msg = JSON.parse(line); } catch { send(fail(null, -32700, 'parse error')); return; }
  const work = (async () => {
    if (Array.isArray(msg)) {
      // Batches were dropped in 2025-06-18; older clients may still send them.
      const out = (await Promise.all(msg.map((x) => handle(x as Message)))).filter(Boolean);
      if (out.length) send(out);
    } else {
      const out = await handle(msg as Message);
      if (out) send(out);
    }
  })().catch((e) => { console.error('mcp:', e); });
  pending.add(work);
  void work.finally(() => pending.delete(work));
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', onLine);
rl.on('close', () => { void Promise.allSettled([...pending]).then(() => process.exit(0)); });
