# Tack: facts for the write-up

Plain notes, to be rewritten. Paths are from the repo root.

## What Tack is

- A career pivot coach for someone changing roles (demo: a backend engineer moving to AI Product Manager in Bengaluru).
- Closes the loop: reads the live job market, maps the gap between the résumé and the target role, plans the move week by week, suggests portfolio projects, runs mock interviews, tracks progress and replans, prepares applications and submits them through a real browser, several in parallel, reads the replies from mail, and learns from which kinds of roles reply.
- An autopilot runs that loop by itself every few hours while the desktop app is open: read, rebuild the gap, rank, prepare kits, apply in parallel, read replies, replan, report.
- Every claim it shows is quoted from its source: résumé lines for skills, posting lines for demand, the candidate's own words for interview scores.
- Runs as a local web app, a macOS desktop app (Electron) and an MCP server over stdio, all on the same state; and as a hosted web preview where each visitor gets a session of their own and applying, mail and the autopilot are off.

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
- Replies from mail (`coach/src/replies.ts`, `POST /api/applications/sync`, "Check replies" on the Tracker): searches mail for every company with an open application, four at a time; one model call (task `mail.classify`, keyword rules as the fallback) sorts each message into interview, reply, rejected, offer, automatic acknowledgement or unrelated; statuses move, the reply rates and lessons relearn, and a "What changed" card lists each move with its subject line. Acknowledgements never count as a reply. Only sender, subject and snippet are kept.
  - Demonstrated on the bundled sample mailbox (12 messages from the demo companies; the demo person never reads real mail). In the rehearsal: 12 messages from 20 searches, 8 status changes, 3 new responses, about 7 s.
  - Real Gmail goes through the engine's read-only search once the person connects it ("Connect Gmail", needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`). Not verified against a real account.
- Automated applying with fan-out (`coach/src/apply.ts`, `POST /api/apply`, `POST /api/apply/top`, "Apply to top N" on the Tracker): Tack starts its own copy of the engine (`coach/src/engine-proc.ts`), gives every posting its own engine session in its own Chrome window, and runs up to 8 at once, started a few seconds apart; one failure stops nothing else. The engine fills the form from the Application details, the résumé file and the kit's answers. Each run streams its steps into a live step card and the trace, and ends confirmed (with the form's reference number) or not sent (with the reason), plus a picture of the page it ended on. A confirmed run is added to the tracker as applied.
  - Windows: Tack asks Chrome, through its own macOS scripting interface, to lay the windows side by side (`coach/src/tile.ts`). That did not take effect in practice: the engine's windows cascade.
  - Practice form (`coach/src/practice.ts`, `/practice/apply/:postingId`): a three-step form Tack serves locally, with a résumé upload, screening questions from the posting, a consent box, a review step and a reference number. Only the demo person and sample postings apply here, never to a company; for anyone else the practice form answers 404 and a sample posting is refused (409).
  - A real person and a live posting go to the real form: Lever and Ashby postings open on their application page, Greenhouse on the posting itself.
- Standing consent (`PUT /api/consent`, a switch under Application details on Start, labelled "Tack may tick consent boxes and submit applications on my behalf"): off by default. The engine runs with its own approval gate; Tack passes the consent to it as its submit-without-asking setting. With consent on, a run ticks consent boxes and presses Submit. Without it, a run fills the form and stops at the consent box or the final Submit, and says why. The demo person comes with consent on, since her forms are Tack's practice form.
- Dry runs on real forms (`TACK_APPLY_DRY_RUN=1`): every form is filled for real and Submit is never pressed; dry runs are recorded apart from applications (`GET /api/apply/dry-runs`). On 21 Nov, against three live postings, nothing submitted:
  - Greenhouse, InMobi: 8 of 11 fields filled, all 3 required ones.
  - Lever, Meesho: 12 of 21 fields filled, 8 of 14 required ones.
  - Ashby, Sarvam AI: 6 of 7 fields filled, all 4 required ones.
  - The résumé file was attached in all three.
- Apply queue (`coach/src/apply-queue.ts`, `GET /api/queue`): every application, by hand or by the autopilot, is a stored job. Idempotent: never two jobs or applications for the same posting, nor for the same company and title under another address (names folded, so "Acme, Inc." and "acme inc" match). Failures fall into seven reasons. Form not found, timed out and site error come back on their own, 5 and then 15 minutes later (three tries in all). CAPTCHA, sign-in required, answer needed and consent needed go to a "needs you" list on the Autopilot screen, with Retry, Skip and, for a question, a box to answer it: the answer is remembered and reused on later forms. Tack never solves a CAPTCHA, signs in or creates an account. A job that was running when Tack stopped goes to the person rather than being retried blind.
- Autopilot (`coach/src/autopilot.ts`, `coach/src/autopilot-steps.ts`, `/api/autopilot`, the Autopilot screen and a block on Progress):
  - A run is eight stored steps: read fresh postings (live boards; closed postings are checked and marked), rebuild the gap map, rank and pick, prepare application kits, apply in parallel through the queue, read replies, replan if behind (or after a weak mock interview or an invitation), and write a report in plain sentences: what was read, what was applied to and why, what came back, what the plan changed. A failed step skips only the steps that need it.
  - Settings: run every 1 to 168 hours (default 12), daily cap 1 to 15 (default 5, hard maximum 15), minimum fit (default 50), roles and companies never to apply to, quiet hours, read replies every N hours (default 6, 0 for only during runs), and "Applications need my approval" (off by default: fully automated; on, picks wait under Needs you for an Apply). "Run now" starts one at once.
  - Switching it on needs a profile, a target role, a name, email and phone, a résumé file and a model key; the screen lists what is missing, and warns when standing consent is off.
  - The scheduler looks every 30 seconds while the app runs: the first run comes about two minutes after switching on, then one per interval, never in quiet hours; it also retries due queue jobs and reads replies on their own clock.
  - Crash and restart: a lock in the store with a 15-second heartbeat keeps two runs from overlapping, here or in another Tack process. A run left running by a crash carries on from the step it was in once its lock has been quiet for 90 seconds; finished steps are not repeated, and older interrupted runs are marked interrupted.
- Hosted web preview (`TACK_HOSTED=1`, `coach/src/hosted.ts`, `docs/DEPLOY.md`, Dockerfile and `fly.toml`): an anonymous session per visitor in a signed, HttpOnly cookie; the store and the trace follow the visitor through AsyncLocalStorage into one SQLite file each, so no visitor sees another's profile, postings, gap, plan, interviews, applications or trace (an end-to-end test runs two visitors at once). Limits: 1 MB JSON and 5 MB résumé bodies, request rates per address and per session, 4 requests in flight per session, and a model budget of 30 calls an hour and 80 a day per session, 600 and 3000 for the whole preview (cache hits are free). Applying, the queue, consent, practice form, mail, the autopilot and the engine answer 409 with a pointer to the desktop app, `/api/state` reports them off, and the screens show "runs in the desktop app" instead. The preview cannot start any child process, so no engine and no Chrome; the scheduler never starts. A call the provider asks to wait more than a minute for fails at once with a plain message. Security headers, same-origin writes, input checks on every write route, no internals in errors, JSON logs without personal data. Sessions expire after 24 hours.
- Opt-in: import applications from a Fanfold database (`TACK_FANFOLD_DB`), read-only.
- Works offline from the model and the boards: bundled demo person (Avery Quinn) with 40 sample postings and a 24-application history; code fallbacks for every model task.
- Every screen has loading, empty and error states and works from 1440 px down to 390 px.

## How the model is used, and where it is not

- Model: Gemini through its OpenAI-compatible endpoint (`coach/src/llm.ts`), `gemini-3.5-flash-lite` in the recorded session (`TACK_MODEL_FAST` picks another). JSON schema output, schema check and repair, disk cache keyed by a hash of model, system prompt, prompt, schema and PDF (`TACK_LLM_CACHE=off` turns it off for reads and writes), retry with backoff on 429 and 5xx, a trace event per call with its duration.
- One model budget for the whole app (`coach/src/limiter.ts`): a per-minute window (`TACK_MODEL_RPM`, 12 by default) shared by Tack's calls and the engine's. The engine reaches the provider through a pass-through on localhost with a key of its own, so the provider key never leaves Tack. Each application session is a lane and lanes take turns, so one busy session cannot starve the others (in hosted mode each visitor is a lane). A 429 pauses every caller, for at most 65 seconds however long the provider asks, and the budget then sends at 60% of its rate and wins it back a request a minute. Long waits show in the trace.
- Model tasks (9): `intake.resume` (on the PDF itself or on pasted text), `intake.roles`, `gap.extract`, `plan.wording`, `portfolio.briefs`, `interview.questions`, `interview.judge`, `kit.tailor`, `mail.classify`.
- The engine's own agent (form filling during applying) calls the same model, inside the same budget.
- Deliberately not the model: finding and ranking postings; the numbers (demand, priority, readiness, fit, hours, dates, streak, reply rates, lift, confidence, the interview overall from the five criterion scores); plan allocation and replanning; tracker lessons and the apply-next ranking; quote verification; the daily brief. The model's numbers are only the résumé skill levels (1-5, editable on the Start screen), the 1-5 rubric scores and the role-overlap estimates.
- Guards on model output: quotes must be found verbatim in their source (résumé, posting or answer) or they are dropped; the stronger interview answer and the kit bullets may only use facts the person stated.

## Measured in this session (21 Nov 2026)

- Boards: 60 configured (33 Greenhouse, 18 Ashby, 9 Lever), 60 of 60 answered; 10,654 open roles scanned, 450 titles fit "AI Product Manager", 40 read. Cold harvest 9.8 s from the command line; 11.0 s inside the recorded take (boards listed and postings read live, no cache).
- With the goal Bengaluru (remote roles on): all 40 postings in India or remote, from 20 companies (InMobi, Razorpay, Meesho, Bureau, Sumo Logic, Netomi, UiPath, Sarvam AI, FamPay, Rubrik, Zeta, Glean, GitLab, Glance, Okta, HackerRank, Fivetran, Hevo Data, Mindtickle, Harvey). Before the ranking fix, US-only remote roles could outrank Indian ones when remote was on.
- Gap build from 40 live postings: 64.6 s cold (8 extraction calls under the 12-a-minute limit, with Gemini 503 retries), about 1 s from cache; 30 to 32 skills, readiness 34 to 37 for the demo résumé depending on the day's postings.
- Plan build 8.6 s cold (55 to 60 tasks). Replan is instant (no model).
- Passing the week 1 checkpoint moved readiness 36 to 38 in the recorded take; marking it "not yet" and replanning added a repair block, dropped one low-priority task that no longer fit and moved 12 tasks later.
- Mock interview answer (79 words) scored 80/100 by the rubric.
- Applying to the local practice form: one application about 17 s; three in parallel about 35 s on a fresh quota, and 94 to 105 s when the free tier's per-minute limit is hit (the engine waits about a minute, then carries on). Rehearsals on 21 Nov: three in parallel in 49 s, all confirmed with reference numbers; another run of three took 96 s, with one run not sent after Gemini answered 503 ("high demand") to every retry.
- Each practice application costs about 7 to 8 engine model calls (form steps), so three in parallel make about 22 calls in well under a minute.
- Replies from the sample mailbox: 12 messages from 20 company searches, sorted in one model call; 8 status changes and 3 new responses, about 7 s; the response rate moved 33% to 46%.
- Without the model cache, a whole run of the demo (résumé to parallel apply) live: résumé read 9.8 s, gap build from 40 postings 20 s (8 calls), plan 24 s (with 503 retries), interview judge 3.8 s, mail sort 4.7 s, application kit 3.8 s.
- Gemini free tier caps per model per day: 500 requests for `gemini-3.5-flash-lite`, 20 for `gemini-3.5-flash`. A full recorded run uses about 45; a day of rehearsals can use up the 500.
- Tests: 175 passing (`cd coach && npm test`), UI typecheck and build clean, desktop `npm run dist` builds a dmg (121.3 MB) and a zip (117.9 MB); the packaged app starts its coach in about 0.65 s.
- Desktop app: the packaged engine starts from the app's own resources (Electron running as Node) and drives the system Chrome with its own profile; inside it, Check replies on the sample mailbox worked, and a practice application opened the form, uploaded the résumé and filled 10 fields before the day's model quota ran out, so its submit was not reached there.
- Desktop app after the merge (21 Nov, evening): it opens, the demo person loads (40 postings, 24 applications, 2 interviews), the Autopilot screen shows the scheduler idle (off, nothing running, nothing queued), Check replies on the sample mailbox gives 12 messages from 20 searches, 8 status changes and 3 new responses, and the engine starts from the packaged resources and answers its health check. No application was run in that check (no model key was given to it, to save the day's quota). Quitting leaves no Tack, engine or Chrome process behind.
- Hosted preview, checked in Chromium with the demo person at 1440x900 and 390x844: all nine screens load with no console error and no failed or refused request; the desktop-only parts show their "runs in the desktop app" state.
- Demo video: 2:46, 1920x1080 H.264, 24 MB, one continuous take of the real app in Chromium at 1440x900. Job boards were read live during the take; model answers came from the cache filled by the warm-up takes, so they appear without waiting. Only the 11 s harvest is sped up (1.6x, labelled).

## Architecture in five lines

- `coach/`: Node 22 TypeScript server, no runtime dependencies (node:http, node:sqlite, fetch); JSON API under `/api`, SSE trace, serves the built UI.
- `ui/`: Vite + React 19 single-page app, plain CSS tokens, motion; talks only to `/api`.
- `engine/`: Fanfold's job-board readers and résumé parser, vendored and not edited; `coach/src/engine-live.ts` is the only file that calls it.
- `desktop/`: Electron shell that runs the coach and opens the UI; `coach/bin/mcp.ts`: the same handlers over MCP stdio.
- State: one SQLite document store plus disk caches for model calls and board reads, under `state/` (or the app's user-data folder); in hosted mode one SQLite file per visitor under `/tmp/tack/sessions`.

## How to run

- Needs Node 22.18 or later. Put the model key in `.env` at the repo root: `GEMINI_API_KEY=...` (or `TACK_MODEL_KEY`, with `TACK_MODEL_URL` for another OpenAI-compatible endpoint).
- Web:
  - `cd ui && npm install && npm run build`
  - `node --no-warnings coach/bin/serve.ts` then open http://127.0.0.1:4400
  - "Load the demo person" on the Start screen fills every screen without a résumé.
- Desktop (macOS, Apple silicon):
  - `cd ui && npm install && npm run build`, then `cd desktop && npm install && npm run dist`
  - Opens from `desktop/out/` (dmg or zip). Dev run: `cd desktop && npm run dev`.
- Web preview: `TACK_HOSTED=1 PORT=8080 node --no-warnings coach/bin/serve.ts` after building the UI, or the Dockerfile; settings and the Fly.io steps in `docs/DEPLOY.md`.
- Dry runs on real forms: start the coach with `TACK_APPLY_DRY_RUN=1`.
- MCP: add to the host config `{"command": "node", "args": ["--no-warnings", "/abs/path/tack/coach/bin/mcp.ts"]}`; details in `docs/MCP.md`.
- Tests: `cd coach && npm test`; UI typecheck and build: `cd ui && npx tsc --noEmit && npm run build`.
- Demo video: `PLAYWRIGHT=/abs/path/playwright/index.mjs node submission/video/record.mjs final` then `node submission/video/render.mjs final`. The recording runs with the model cache off (`TACK_LLM_CACHE=off` unless set otherwise) and exits with code 3 if the parallel apply does not end with every run confirmed.

## Honest limits

- The macOS build is unsigned (ad-hoc identity), so Gatekeeper asks the first time: right-click, Open.
- Real Gmail needs the person to connect it once (Google client id and secret, Google's consent window); reply reading was demonstrated on the sample mailbox only and has not been verified against a real account.
- No application was submitted to a real company. Real forms were exercised only as dry runs (three, above), which filled most fields but not all: the Lever form left 6 of its 14 required fields empty. A question the engine cannot answer, a CAPTCHA or a sign-in stops a run, which then goes to the "needs you" list.
- Window tiling was not achieved: the parallel application windows cascade instead of sitting side by side.
- The autopilot's steps, scheduling and crash-resume are covered by tests with stand-in steps; a scheduled run against live companies with real submits was not run.
- Parallel applies and the autopilot share one model budget with the coach. On Gemini's free tier, three at once can hit the per-minute limit, and everything then waits its turn (see the timings above).
- The web preview runs as a single instance (sessions, limits and budgets live in one process) and keeps visitors' data for 24 hours; it reads the bundled sample market when the job boards cannot be reached.
- The tracker in the demo learns from sample data (the demo person's 24 applications, marked "sample" on every card and in the "What gets replies" panel).
- The free model tier (15 requests a minute, 500 a day for `gemini-3.5-flash-lite`) makes a cold gap build take up to about a minute; the cache makes repeats fast.
- Board list is fixed (60 companies); a role with few postings on those boards gets fewer than 40.

## Disclosure

- The posting reader (job-board APIs) and the résumé parser come from Fanfold, the author's own earlier browser agent, vendored under `engine/` without changes. Everything else (coach, UI, desktop app, MCP server, the gap maths, planner, interview rubric, tracker) was built during the hackathon.
