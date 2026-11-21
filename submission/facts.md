# Tack: facts for the write-up

Plain notes, to be rewritten. Paths are from the repo root.

## What Tack is

- A career pivot coach for someone changing roles (demo: a backend engineer moving to AI Product Manager in Bengaluru).
- Closes the loop: reads the live job market, maps the gap between the résumé and the target role, plans the move week by week, suggests portfolio projects, runs mock interviews, tracks progress and replans, prepares applications, and learns from which kinds of roles reply.
- Every claim it shows is quoted from its source: résumé lines for skills, posting lines for demand, the candidate's own words for interview scores.
- Runs as a local web app, a macOS desktop app (Electron) and an MCP server over stdio, all on the same state.

## The seven requirements, and how Tack meets each

1. Résumé and target-role intake
   - PDF upload or pasted text (`coach/src/intake.ts` `parseResume`). The PDF goes to the model as a file (task `intake.resume`); its text is also read locally by the engine's reader (`coach/src/engine-live.ts` `resumeText`, from `engine/src/memory/import.ts`) and used to check every quote, and as the fallback when the endpoint will not take a PDF.
   - Every skill must carry a quote from the résumé; `finishProfile` checks each quote against the résumé text and drops skills without one.
   - Target role, location, remote toggle, hours a week and weeks on the Start screen (`ui/src/screens/Start.tsx`), saved through `PUT /api/goal`.
   - "Roles next door": the model suggests five adjacent roles with an overlap estimate and a one-line why (`intake.ts` `suggestRoles`, task `intake.roles`); with no model, a code table computes them from the profile (`adjacentRoles`).
2. Skill-gap map built from real job descriptions
   - Harvest: 60 public company job boards (33 Greenhouse, 18 Ashby, 9 Lever; list in `coach/src/boards.ts`) read through their public APIs, no browser, no sign-in (`engine-live.ts` `harvest`, board and posting readers from `engine/src/jobs/ats.ts`).
   - Ranking in code: title fit to the target role, place (city, then country, then remote open to that country; roles placed only elsewhere sink below every local one), recency, and a text bonus when the posting's body keeps returning to the role's modifier ("AI"). At most a few postings per company.
   - Extraction: the model reads postings in batches of five and returns each skill with must/nice and a verbatim quote (`coach/src/gap.ts` `extractSkills`, task `gap.extract`). Quotes not found in the posting text are dropped (`cleanSkills`, `skills.ts` `findQuote`).
   - Maths in code (`gap.ts` `computeGap`): demand = share of postings asking; mustShare; need from demand and mustShare; have = the profile level of that skill (or of a skill that implies it, minus a fixed drop from a table in `skills.ts`); level strong/partial/missing; priority = round(100 x demand x (need - have)/5 x (0.6 + 0.4 x mustShare)); readiness = demand-weighted mean of min(have/need, 1). Skill names normalised through an alias table (`coach/src/skills.ts`). Bridges (a skill the person has that transfers) come from a table in `skills.ts`.
   - UI: `ui/src/screens/Gap.tsx`: readiness dial, top five to close, constellation (size = demand, fill = level), evidence drawer with résumé quotes on one side and posting quotes with company names on the other.
3. Week-by-week learning plan
   - `coach/src/plan.ts` `buildPlan`: code allocates open skills to weeks by priority and prerequisite order inside the weekly hours budget, schedules practice, a portfolio project, mock interviews and application batches, and owns ids, hours and dates. The model only writes task titles, checkpoints and resource queries (`wordPlan`, task `plan.wording`). Resource links are search links built in code.
   - Each week has a checkpoint (passed / not yet). Calendar export as .ics (`toIcs`, `GET /api/plan/calendar.ics`).
   - UI: `ui/src/screens/Plan.tsx`.
4. Portfolio project suggestions matched to the gaps
   - `coach/src/portfolio.ts`: code picks three projects that each cover at least two open gap skills (`pickProjects`), ties them to plan weeks, and attaches posting quotes that ask for those skills (`quotesFor`). The model writes the brief, milestones and deliverables (task `portfolio.briefs`); code templates are the fallback.
   - UI: `ui/src/screens/Portfolio.tsx` (coverage strip, milestones on plan weeks, "why it counts" quotes with company names).
5. Mock interviews scored against a rubric
   - `coach/src/interview.ts`: five questions from the target postings and the open gaps (task `interview.questions`); rubric with five anchored criteria (structure, relevance to the role, depth, evidence and metrics, clarity), 1 to 5 each with a reason and a quote from the answer (task `interview.judge`).
   - Code checks every quote is verbatim from the answer (`verbatimQuote`), computes the overall score (`overallScore`), and strips invented facts from the stronger answer (`guardInvented`). Plus one follow-up probe.
   - Scores feed back: above 4 on a skill's questions raises `have`; a session under 50 adds practice at the next replan.
   - UI: `ui/src/screens/Interview.tsx`, `ui/src/screens/interview/Room.tsx`.
6. Progress tracking that adjusts the plan
   - `coach/src/progress.ts`: readiness over time, hours done against expected, streak, on-track check, daily brief of three things (`brief`).
   - `plan.ts` `replan`: deterministic; late tasks roll forward, weeks rebalance to the hours budget, a closed skill frees its remaining hours, a failed checkpoint adds a repair block, a weak interview adds practice. Records a PlanChange ("what moved and why"), shown as a card and in the plan history.
   - Ticking tasks and passing checkpoints raise `have` for the week's skills, so readiness moves (seen in this session: 37 to 39 after one checkpoint).
   - UI: `ui/src/screens/Progress.tsx`, diff card in `Plan.tsx`.
7. Application tracker that learns which kinds of roles get responses
   - `coach/src/tracker.ts`: response = reply, interview or offer. Per segment (role family, seniority, company size, source, fit band) a Beta(1,1) posterior on the response rate; lift = segment mean / overall mean; confidence from sample size. Ghosted = more than 14 days with no event.
   - Lessons are plain sentences written by code from the strongest and weakest segments, not by the model.
   - "Apply next" ranks unapplied postings by Thompson sampling over the segment posteriors blended with fit.
   - UI: `ui/src/screens/Tracker.tsx`, kanban in `ui/src/screens/tracker/Pipeline.tsx`.

## Beyond the brief

- Live market: real postings from real company boards, read in about 10 seconds, with an agent trace rail streaming each step over SSE (`GET /api/events`, `coach/src/trace.ts`, `ui/src/ui/TraceRail.tsx`).
- Application kit (`coach/src/kit.ts`, `POST /api/kit/:postingId`): headline, tailored résumé bullets each shown with the résumé line it comes from (bullets that cannot be traced back are dropped by `guardBullets`), cover note, talking points, gaps to address honestly, questions to ask.
- MCP server (`coach/bin/mcp.ts`, `docs/MCP.md`): eight tools (state, gap, plan week, complete task, next applications, prepare application, interview question, interview answer) against the same state as the app.
- Desktop app (`desktop/`): Electron shell that starts the coach, a key screen for the model key, crash watchdog.
- Opt-in live sources: import applications from a Fanfold database (`TACK_FANFOLD_DB`), read recruiter replies from Gmail (`TACK_GMAIL=1`); both read-only.
- Works offline from the model and the boards: bundled demo person (Avery Quinn) with 40 sample postings and a 24-application history; code fallbacks for every model task.
- Every screen has loading, empty and error states and works from 1440 px down to 390 px.

## How the model is used, and where it is not

- Model: Gemini through its OpenAI-compatible endpoint (`coach/src/llm.ts`), `gemini-3.5-flash-lite` in this session. JSON schema output, schema check and repair, disk cache keyed by the request hash, a shared rate limiter (12 a minute by default), retry with backoff on 429 and 5xx, a trace event per call.
- Model tasks (8): `intake.resume` (on the PDF itself or on pasted text), `intake.roles`, `gap.extract`, `plan.wording`, `portfolio.briefs`, `interview.questions`, `interview.judge`, `kit.tailor`.
- Deliberately not the model: finding and ranking postings; the numbers (demand, priority, readiness, fit, hours, dates, streak, reply rates, lift, confidence, the interview overall from the five criterion scores); plan allocation and replanning; tracker lessons and the apply-next ranking; quote verification; the daily brief. The model's numbers are only the résumé skill levels (1-5, editable on the Start screen), the 1-5 rubric scores and the role-overlap estimates.
- Guards on model output: quotes must be found verbatim in their source (résumé, posting or answer) or they are dropped; the stronger interview answer and the kit bullets may only use facts the person stated.

## Measured in this session (21 Nov 2026)

- Boards: 60 configured (33 Greenhouse, 18 Ashby, 9 Lever), 60 of 60 answered; 10,654 open roles scanned, 450 titles fit "AI Product Manager", 40 read. Cold harvest 9.8 s from the command line; 11.0 s inside the recorded take (boards listed and postings read live, no cache).
- With the goal Bengaluru (remote roles on): all 40 postings in India or remote, from 20 companies (InMobi, Razorpay, Meesho, Bureau, Sumo Logic, Netomi, UiPath, Sarvam AI, FamPay, Rubrik, Zeta, Glean, GitLab, Glance, Okta, HackerRank, Fivetran, Hevo Data, Mindtickle, Harvey). Before the ranking fix, US-only remote roles could outrank Indian ones when remote was on.
- Gap build from 40 live postings: 64.6 s cold (8 extraction calls under the 12-a-minute limit, with Gemini 503 retries), about 1 s from cache; 30 to 32 skills, readiness 34 to 37 for the demo résumé depending on the day's postings.
- Plan build 8.6 s cold (55 to 60 tasks). Replan is instant (no model).
- Passing the week 1 checkpoint moved readiness 36 to 38 in the recorded take; marking it "not yet" and replanning added a repair block, dropped one low-priority task that no longer fit and moved 12 tasks later.
- Mock interview answer (79 words) scored 80/100 by the rubric.
- Tests: 112 passing (`cd coach && npm test`), UI typecheck and build clean, desktop `npm run dist` builds a dmg and zip (about 120 MB each); the packaged app starts its coach in about 0.7 s.
- Demo video: 2:46, 1920x1080 H.264, 24 MB, one continuous take of the real app in Chromium at 1440x900. Job boards were read live during the take; model answers came from the cache filled by the warm-up takes, so they appear without waiting. Only the 11 s harvest is sped up (1.6x, labelled).

## Architecture in five lines

- `coach/`: Node 22 TypeScript server, no runtime dependencies (node:http, node:sqlite, fetch); JSON API under `/api`, SSE trace, serves the built UI.
- `ui/`: Vite + React 19 single-page app, plain CSS tokens, motion; talks only to `/api`.
- `engine/`: Fanfold's job-board readers and résumé parser, vendored and not edited; `coach/src/engine-live.ts` is the only file that calls it.
- `desktop/`: Electron shell that runs the coach and opens the UI; `coach/bin/mcp.ts`: the same handlers over MCP stdio.
- State: one SQLite document store plus disk caches for model calls and board reads, under `state/` (or the app's user-data folder).

## How to run

- Needs Node 22.18 or later. Put the model key in `.env` at the repo root: `GEMINI_API_KEY=...` (or `TACK_MODEL_KEY`, with `TACK_MODEL_URL` for another OpenAI-compatible endpoint).
- Web:
  - `cd ui && npm install && npm run build`
  - `node --no-warnings coach/bin/serve.ts` then open http://127.0.0.1:4400
  - "Load the demo person" on the Start screen fills every screen without a résumé.
- Desktop (macOS, Apple silicon):
  - `cd ui && npm install && npm run build`, then `cd desktop && npm install && npm run dist`
  - Opens from `desktop/out/` (dmg or zip). Dev run: `cd desktop && npm run dev`.
- MCP: add to the host config `{"command": "node", "args": ["--no-warnings", "/abs/path/tack/coach/bin/mcp.ts"]}`; details in `docs/MCP.md`.
- Tests: `cd coach && npm test`; UI typecheck and build: `cd ui && npx tsc --noEmit && npm run build`.
- Demo video: `PLAYWRIGHT=/abs/path/playwright/index.mjs node submission/video/record.mjs final` then `node submission/video/render.mjs final`.

## Honest limits

- The macOS build is unsigned (ad-hoc identity), so Gatekeeper asks the first time: right-click, Open.
- Reading recruiter replies from mail is built but not connected by default (needs a Google client and `TACK_GMAIL=1`); in the demo, replies are moved by hand or come from the sample history.
- Applying is prepared, not performed: the kit is ready to paste, and the submit is handed to the person (or to Fanfold, where every answer is checked and the person approves).
- The tracker in the demo learns from sample data (the demo person's 24 applications, marked "sample" on every card and in the "What gets replies" panel).
- The free model tier (15 requests a minute) makes a cold gap build take about a minute; the cache makes repeats fast.
- Board list is fixed (60 companies); a role with few postings on those boards gets fewer than 40.

## Disclosure

- The posting reader (job-board APIs) and the résumé parser come from Fanfold, the author's own earlier browser agent, vendored under `engine/` without changes. Everything else (coach, UI, desktop app, MCP server, the gap maths, planner, interview rubric, tracker) was built during the hackathon.
