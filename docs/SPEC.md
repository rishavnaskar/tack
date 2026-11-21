# Tack — build spec

Tack is a career pivot coach that closes the loop: it reads the live job market, maps the
gap between a résumé and a target role, plans the pivot week by week, drills interviews,
applies through a real browser, and learns from who replies.

Deadline: 21 Nov 2026 23:59 IST. Everything here must work in **demo mode** (no Chrome,
no network except the model) and get better in **live mode** (engine attached).

## Layout and ownership

```
engine/    Fanfold, copied as is. Nobody edits it.
coach/     Node 22 TypeScript server, zero runtime deps (node:http, node:sqlite, fetch).
           Run with `node --no-warnings coach/bin/serve.ts`. Port 4400.
ui/        Vite + React 19 + TypeScript SPA. Built to ui/dist, served by coach.
desktop/   Electron shell. Starts coach, opens the window.
docs/      This spec.
```

Rules for every builder:
- Write as a human engineer would. Comments only where the code is not obvious, one short
  line. No AI or assistant mentions anywhere. No emojis in code or UI.
- Never use real personal data. The demo person is "Avery Quinn"; hosts are `.example`.
- Stay inside the directory you own. Shared contract is `coach/src/types.ts` (owned by
  the coach-core builder, written first, copied verbatim from this spec).
- Each module gets unit tests with `node --test` where it has pure logic.
- Finish with a short hand-off: what works, what is stubbed, how to run.

## Types (`coach/src/types.ts`)

```ts
export type Level = 'strong' | 'partial' | 'missing';
export interface ProfileSkill { id: string; name: string; level: number; evidence: string[] } // level 1-5
export interface Role { title: string; company: string; start: string; end: string; bullets: string[] }
export interface Profile {
  name: string; headline: string; currentRole: string; yearsExperience: number; summary: string;
  skills: ProfileSkill[]; experience: Role[]; education: string[]; projects: string[];
  source: 'pdf' | 'text' | 'demo';
}
export interface Goal {
  targetRole: string; location: string; remote: boolean;
  hoursPerWeek: number; weeks: number; startDate: string; notes: string;
}
export interface Posting {
  id: string; title: string; company: string; location: string; url: string; source: string;
  postedAt?: string; salary?: string; text: string; harvestedAt: string; live: boolean;
  roleFamily?: string; seniority?: string; companySize?: 'startup' | 'scaleup' | 'enterprise';
  skills?: { skillId: string; name: string; importance: 'must' | 'nice'; quote: string }[];
  fit?: number; // 0-100 against the profile
}
export interface GapSkill {
  id: string; name: string; category: string;
  demand: number;        // share of postings asking for it, 0-1
  mustShare: number;     // share listing it as a must
  level: Level; have: number; need: number; // have 0-5, need 1-5
  evidence: { resume: string[]; postings: { postingId: string; company: string; quote: string }[] };
  bridge?: { from: string; note: string }; // skill the person has that transfers
  priority: number;      // 0-100, demand x gap
  status: 'open' | 'learning' | 'closed';
}
export interface GapMap {
  postingCount: number; generatedAt: string; readiness: number; // demand-weighted coverage 0-100
  skills: GapSkill[]; summary: string;
  market: { topCompanies: { name: string; count: number }[]; locations: { name: string; count: number }[];
            seniority: { name: string; count: number }[]; salaryNote: string };
}
export interface PlanTask {
  id: string; title: string; kind: 'learn' | 'practice' | 'project' | 'interview' | 'apply';
  skillIds: string[]; hours: number; resource?: { title: string; url: string; verified: boolean };
  status: 'todo' | 'done' | 'skipped'; doneAt?: string;
}
export interface PlanWeek {
  index: number; startDate: string; theme: string; skillIds: string[]; hours: number;
  tasks: PlanTask[]; checkpoint: { title: string; description: string; passed?: boolean };
}
export interface PlanChange { at: string; reason: string; summary: string; moved: string[] }
export interface Plan { version: number; createdAt: string; weeks: PlanWeek[]; changes: PlanChange[] }
export interface PortfolioProject {
  id: string; title: string; pitch: string; skillIds: string[]; brief: string;
  milestones: { title: string; week: number }[]; deliverables: string[]; reviewerSees: string;
  postingQuotes: { company: string; quote: string }[]; status: 'idea' | 'building' | 'shipped';
}
export interface RubricScore { criterion: string; score: number; why: string; quote?: string } // 1-5
export interface InterviewQuestion { id: string; kind: 'behavioural' | 'technical' | 'case'; text: string; skillIds: string[]; fromPosting?: string }
export interface InterviewTurn {
  questionId: string; answer: string; scores: RubricScore[]; overall: number; // 0-100
  strengths: string[]; fixes: string[]; betterAnswer: string; followUp?: string; at: string;
}
export interface InterviewSession {
  id: string; kind: 'behavioural' | 'technical' | 'case' | 'mixed'; postingId?: string;
  questions: InterviewQuestion[]; turns: InterviewTurn[]; score?: number; startedAt: string; finishedAt?: string;
}
export type AppStatus = 'applied' | 'viewed' | 'reply' | 'interview' | 'offer' | 'rejected' | 'ghosted';
export interface Application {
  id: string; postingId?: string; title: string; company: string; url: string;
  roleFamily: string; seniority: string; companySize: string; source: string; fit: number;
  appliedAt: string; status: AppStatus; lastEventAt: string;
  events: { at: string; kind: string; note: string }[]; origin: 'fanfold' | 'manual' | 'demo';
}
export interface Segment { dimension: string; value: string; sent: number; responses: number; rate: number; lift: number; confidence: 'low' | 'medium' | 'high' }
export interface TrackerInsights {
  overall: { sent: number; responses: number; rate: number };
  segments: Segment[]; lessons: string[];
  next: { postingId: string; title: string; company: string; url: string; fit: number; responseChance: number; why: string }[];
}
export interface Progress {
  readiness: { at: string; value: number }[]; hoursDone: number; hoursPlanned: number;
  tasksDone: number; tasksTotal: number; skillsClosed: number; interviewAvg: { at: string; value: number }[];
  streakDays: number; onTrack: boolean; note: string;
}
export interface TraceEvent { id: string; at: string; run: string; step: string; detail: string; status: 'start' | 'ok' | 'fail'; ms?: number }
export interface AppState {
  mode: 'demo' | 'live'; engine: { available: boolean; note: string };
  model: { configured: boolean; name: string };
  profile?: Profile; goal?: Goal; counts: { postings: number; applications: number; interviews: number };
  has: { gap: boolean; plan: boolean; portfolio: boolean };
}
```

## HTTP API (coach, JSON, all under `/api`)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /state | | AppState |
| POST | /demo/load | | AppState (loads the Avery Quinn snapshot: profile, goal, 40 postings, gap, plan, portfolio, 2 interviews, 24 applications) |
| POST | /reset | | AppState |
| POST | /profile/resume | `{text}` or `{pdfBase64, filename}` | Profile |
| PUT | /profile | Profile | Profile |
| PUT | /goal | Goal | Goal |
| POST | /roles/suggest | | `{roles: {role, overlap, why}[]}` adjacent target roles from the profile |
| POST | /postings/harvest | `{count}` | `{postings: Posting[], live: boolean}` live through the engine, else the bundled snapshot |
| GET | /postings | | Posting[] |
| POST | /gap/build | | GapMap |
| GET | /gap | | GapMap |
| POST | /plan/build | | Plan |
| GET | /plan | | Plan |
| PATCH | /plan/tasks/:id | `{status}` | `{plan: Plan, progress: Progress}` |
| POST | /plan/checkpoint/:week | `{passed}` | Plan |
| POST | /plan/replan | `{reason?}` | Plan (version + 1, new PlanChange) |
| GET | /plan/calendar.ics | | text/calendar |
| POST | /portfolio/build | | PortfolioProject[] |
| GET | /portfolio | | PortfolioProject[] |
| PATCH | /portfolio/:id | `{status}` | PortfolioProject |
| POST | /interviews | `{kind, postingId?}` | InterviewSession (5 questions) |
| POST | /interviews/:id/answer | `{questionId, answer}` | `{turn: InterviewTurn, session: InterviewSession}` |
| GET | /interviews | | InterviewSession[] |
| GET | /applications | | Application[] |
| POST | /applications | partial Application | Application |
| PATCH | /applications/:id | `{status, note?}` | Application |
| POST | /applications/sync | | `{added, updated}` pulls engine records and mail replies when live |
| GET | /tracker/insights | | TrackerInsights |
| POST | /apply | `{postingId}` | `{started: boolean, note}` hands the posting to the engine (live only) |
| GET | /progress | | Progress |
| GET | /brief | | `{headline, items: {kind, text, action?}[]}` today's three things |
| GET | /events | | SSE stream of TraceEvent |

Errors: `{error: string}` with 4xx/5xx. Long calls (harvest, gap, plan) hold the request
open and emit TraceEvents meanwhile so the UI can show the agent working.

## Coach internals

Foundation (`coach/src/`):
- `server.ts` tiny router over node:http, JSON helpers, SSE hub, static serving of `ui/dist`
  with SPA fallback.
- `store.ts` node:sqlite document store. `get<T>(kind, id)`, `put(kind, id, value)`,
  `list<T>(kind)`, `del(kind, id)`, `clear()`. One table `docs(kind, id, json, updated_at)`.
  State dir from `TACK_STATE_DIR`, default `./state`.
- `llm.ts` one function: `json<T>(opts: {task: string; system: string; prompt: string;
  schema: object; tier?: 'fast' | 'smart'; pdfBase64?: string}): Promise<T>`.
  OpenAI-compatible chat completions with `response_format` JSON schema.
  Env: `TACK_MODEL_URL` (default Gemini's OpenAI-compatible endpoint
  `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`),
  `TACK_MODEL_KEY` (falls back to `GEMINI_API_KEY`), `TACK_MODEL_FAST`, `TACK_MODEL_SMART`.
  Must have: disk cache keyed by sha256 of the request (in `state/llm-cache`), a rate
  limiter (default 12 requests/minute, env override), retry with backoff on 429/5xx,
  JSON repair + schema check, and a TraceEvent per call (`task`, ms, cached or not).
- `trace.ts` `run(name)` returns `{step(step, detail), ok(), fail()}` and publishes to SSE.
- `engine.ts` the ONLY file that touches `../engine`. Exposes `available()`,
  `harvest(role, location, count)`, `applications()`, `mailReplies(companies)`,
  `apply(url)`, `verifyUrl(url)`. Every call degrades to "not available" without throwing.
- `demo/` snapshot JSON files and `load.ts`.

Domain modules (pure logic separated from model calls so it can be tested):

1. `intake.ts` résumé text or PDF to Profile. Every skill must carry evidence quoted from
   the résumé; skills without a quote are dropped. Adjacent-role suggestions.
2. `skills.ts` skill normalisation: lowercase id, alias table (e.g. "a/b testing" =
   "experimentation"), categories. Shared by gap, plan, interview.
3. `gap.ts` per posting: extract skills with must/nice and a verbatim quote (one model
   call per batch of 5 postings). Then pure maths: demand, mustShare, need (from
   importance and frequency), have (from profile evidence), level, bridge, priority =
   round(100 * demand * (need - have) / 5 * (0.6 + 0.4 * mustShare)), readiness =
   demand-weighted mean of min(have / need, 1). Posting `fit` uses the same maths per posting.
4. `plan.ts` allocate skills to weeks by priority and prerequisite order inside the
   hours budget; the model writes task titles, checkpoints and resource suggestions; code
   owns ids, hours and dates. Resources are search links built in code unless the engine
   verified a URL. Interview practice and application batches are scheduled as tasks.
   `replan()` is deterministic on progress: late tasks roll forward, weeks rebalance to
   the hours budget, a closed skill frees its remaining hours, a failed checkpoint adds a
   repair block; it records a PlanChange saying what moved and why.
5. `portfolio.ts` three projects, each covering at least two open gap skills, tied to
   plan weeks and to quotes from postings.
6. `interview.ts` questions built from the target postings and the open gaps. Rubric with
   five anchored criteria (structure, relevance to the role, depth, evidence and metrics,
   clarity), each 1-5 with a reason and a quote from the answer. Returns a stronger
   version of the answer using only facts the person stated, plus one follow-up probe.
   Scores above 4 on a skill's questions raise `have` for that skill; a session average
   below 50 adds practice tasks at the next replan.
7. `tracker.ts` response = status in reply, interview, offer. Per segment (roleFamily,
   seniority, companySize, source, fit band) a Beta(1,1) posterior on response rate;
   `lift` = segment mean / overall mean; confidence from sample size (<5 low, <12 medium).
   `next` ranks unapplied postings by Thompson sampling over the segment posteriors
   blended with fit. Lessons are plain sentences generated from the top and bottom
   segments by code, not by the model. Ghosted = applied more than 14 days ago, no event.
8. `progress.ts` readiness history, hours, streak, on-track check, daily brief.

Demo snapshot: Avery Quinn, 5 years as a backend engineer, pivoting to AI Product
Manager in Bengaluru, 10 hours a week for 12 weeks. 40 postings with realistic text from
invented companies on `.example` hosts, flagged `live: false`. 24 applications across
role families with a built-in pattern (growth/platform PM roles at scaleups reply more
than enterprise generalist roles) so the tracker has something true to find.

## UI

Same family as fanfold.buildforge.top (modelled on oryzo.ai):
- Tokens: ink `#0B0B0C`, ink-soft `#1A1918`, paper `#F7F6F4`, cream `#EFE6D6`, olive
  `#4E5A3C`, accent `#F0521C`, accent-hi `#FF7A3D`, line `rgba(247,246,244,.22)`, mute
  `rgba(247,246,244,.62)`. One accent only.
- Type: Host Grotesk (display and body), JetBrains Mono (labels, telemetry, numbers).
  Fonts bundled locally (fontsource), no network at runtime.
- Feel: dark, calm, editorial. Giant wordmark, frosted cards over a dark surface, thin
  hairlines, mono uppercase micro-labels with index numbers (01, 02), generous spacing,
  slow eased motion, a right-edge vertical tab for the agent trace. Text never sits on
  busy art.

Screens (left rail navigation, numbered):
- `00 Start` intake: drop a résumé or paste it, pick the target role (with suggested
  adjacent roles), hours and weeks. "Load the demo person" is one click.
- `01 Market` harvested postings as a wall of small browser-window cards that fill in as
  the agent reads them; filters; fit per posting.
- `02 Gap map` the centrepiece. Skills as a constellation: size = demand, fill = level
  (strong solid paper, partial half ring, missing accent outline). Click a skill for the
  evidence drawer: résumé quotes on the left, posting quotes with company names on the
  right, the bridge note, and its place in the plan. Readiness dial on top.
- `03 Plan` week columns with tasks, hours bar, checkpoints, tick to complete; replan
  shows a diff card "what moved and why"; calendar export.
- `04 Portfolio` three project cards with skills covered, milestones, posting quotes.
- `05 Interview` one question at a time, large type, answer box, then the rubric as five
  bars with reasons and quotes, the stronger answer, the follow-up. Session history chart.
- `06 Tracker` kanban by status, the "what gets replies" panel with segment bars and
  lessons, and "apply next" ranked list with an Apply button.
- `07 Progress` readiness over time, hours, streak, today's brief.
- Agent trace rail: collapsible right-edge tab, mono lines streaming from `/api/events`.

Every screen has loading, empty and error states. Works from 1100px wide down to 390px.
