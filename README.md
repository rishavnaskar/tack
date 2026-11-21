# Tack

Tack is a career pivot coach. It reads live job postings, maps them against your résumé with the exact lines as proof, plans the move week by week, drills interviews, and learns from which applications get replies.

## What it does

| Requirement | How Tack meets it |
| --- | --- |
| Résumé and target-role intake | Accepts uploaded PDFs or pasted text (`coach/src/intake.ts`, `parseResume`). The PDF is sent directly to the model as a file (task `intake.resume`), while the local engine reader (`coach/src/engine-live.ts`, `resumeText`, using `engine/src/memory/import.ts`) extracts text locally to verify quotes and serve as a fallback if the endpoint cannot take PDFs. Every extracted skill must include an exact quote from the résumé; `finishProfile` verifies each quote against the text and discards any skill without one. Users configure their target role, location, remote work preference, weekly hours budget, and timeline on the Start screen (`ui/src/screens/Start.tsx`), saved via `PUT /api/goal`. The model also suggests five "roles next door" with estimated overlap percentages and one-line explanations (`intake.ts`, `suggestRoles`, task `intake.roles`), falling back to a hardcoded table (`adjacentRoles`) if no model is connected. |
| Skill-gap map built from real job descriptions | Harvests postings from 60 public company job boards (33 Greenhouse, 18 Ashby, 9 Lever; listed in `coach/src/boards.ts`) using their public APIs without a browser or login (`engine-live.ts`, `harvest`, with readers from `engine/src/jobs/ats.ts`). Ranks postings in code by title match, location (city first, then country, then country-compatible remote; roles based elsewhere rank below all local roles), recency, and keyword density for role modifiers like "AI", capping results at a few postings per company. The model processes postings in batches of five to extract skills, marking each as must-have or nice-to-have alongside a verbatim quote (`coach/src/gap.ts`, `extractSkills`, task `gap.extract`); quotes missing from the posting text are discarded (`cleanSkills`, `skills.ts`, `findQuote`). Code computes the gap (`gap.ts`, `computeGap`): `demand` is the share of postings requesting the skill; `mustShare` is the proportion marking it mandatory; `need` is derived from demand and mustShare; `have` comes from the profile's current level (or an implied skill, minus a penalty from a lookup table in `skills.ts`); proficiency is categorized as strong, partial, or missing; `priority = round(100 x demand x (need - have)/5 x (0.6 + 0.4 x mustShare))`; and `readiness` is the demand-weighted average of `min(have/need, 1)`. Skill aliases and transferable bridge skills are mapped via lookup tables in `coach/src/skills.ts`. The Gap screen (`ui/src/screens/Gap.tsx`) displays a readiness dial, top five priority skills, a constellation visualization (node size represents demand, fill shows proficiency), and an evidence drawer pairing résumé quotes against job posting quotes with company names. |
| Week-by-week learning plan | `coach/src/plan.ts` (`buildPlan`) schedules unmastered skills into weekly blocks by priority and prerequisites within the user's weekly study budget. Code schedules practice, a portfolio project, mock interviews, and application sprints, managing all IDs, hours, and calendar dates. The model is only used to generate task titles, checkpoints, and search queries for study resources (`wordPlan`, task `plan.wording`), while resource URLs are constructed as search links in code. Each week ends with a checkpoint (marked passed or not yet), and plans can be exported as an `.ics` calendar (`toIcs`, `GET /api/plan/calendar.ics`). Displayed on `ui/src/screens/Plan.tsx`. |
| Portfolio project suggestions matched to the gaps | `coach/src/portfolio.ts` selects three projects that each cover at least two open skill gaps (`pickProjects`), pins them to plan weeks, and attaches matching job posting quotes (`quotesFor`). The model drafts the project brief, milestone checklist, and deliverables (task `portfolio.briefs`), falling back to code templates if unavailable. Displayed on `ui/src/screens/Portfolio.tsx` with a skill coverage indicator, plan milestone alignment, and "why it counts" quotes with company names. |
| Mock interviews scored against a rubric | `coach/src/interview.ts` generates five interview questions drawn directly from target postings and open gap skills (task `interview.questions`). An evaluation rubric scores answers across five anchored criteria: structure, relevance to the role, depth, evidence and metrics, and clarity. Each criterion is scored from 1 to 5 with an explanation and an excerpt quoted from the user's answer (task `interview.judge`). Code validates that every quote appears verbatim in the answer (`verbatimQuote`), computes the overall score (`overallScore`), strips unmentioned facts from the model's suggested stronger answers (`guardInvented`), and generates one follow-up probe. Scores update the profile: scoring above 4 on a skill's questions increases `have`, while a session score under 50 schedules extra practice during the next replan. UI runs on `ui/src/screens/Interview.tsx` and `ui/src/screens/interview/Room.tsx`. |
| Progress tracking that adjusts the plan | `coach/src/progress.ts` tracks readiness trends over time, completed versus planned hours, active streaks, on-track status, and a three-item daily brief (`brief`). When adjustments are needed, `plan.ts` (`replan`) runs deterministically: overdue tasks roll forward, weekly loads rebalance to the study budget, mastering a skill early frees up remaining hours, a failed checkpoint adds a review block, and weak interview scores add practice tasks. Each adjustment generates a `PlanChange` log ("what moved and why"), shown as a diff card and saved to plan history. Checking off tasks and passing checkpoints raises `have` for targeted skills, improving overall readiness (demonstrated by a move from 37 to 39 after one checkpoint). UI located at `ui/src/screens/Progress.tsx` and the diff card in `Plan.tsx`. |
| Application tracker that learns which kinds of roles get responses | `coach/src/tracker.ts` tracks outcomes where a response is defined as a reply, interview, or offer. Tracks performance across segments (role family, seniority, company size, source, and fit band) using a Beta(1,1) posterior distribution on response rates. Calculates lift as the segment average divided by the overall average, along with confidence derived from sample size. Applications without updates for over 14 days are marked as ghosted. Key takeaways are written as simple sentences by code based on top and bottom segments, not by the model. The "Apply next" feature ranks unapplied postings using Thompson sampling over segment posteriors combined with role fit. UI located at `ui/src/screens/Tracker.tsx` and the pipeline board at `ui/src/screens/tracker/Pipeline.tsx`. |

## Beyond the brief

- Live market reader: Fetches live postings from company boards in about 10 seconds, streaming every search step over Server-Sent Events (`GET /api/events`, `coach/src/trace.ts`, `ui/src/ui/TraceRail.tsx`).
- Application kit generator (`coach/src/kit.ts`, `POST /api/kit/:postingId`): Generates a role headline, tailored résumé bullet points mapped directly to original résumé lines (`guardBullets` drops bullets that cannot be traced back), a cover letter, talking points, honest talking points for open skill gaps, and questions to ask the interviewer.
- MCP server integration (`coach/bin/mcp.ts`, `docs/MCP.md`): Exposes eight tools (state, gap, plan week, complete task, next applications, prepare application, interview question, and interview answer) over stdio against the exact same data store as the web app.
- Native desktop wrapper (`desktop/`): Electron shell that manages the coach process, provides an API key configuration screen, and includes a crash monitor.
- Optional external integrations: Read-only import of existing job applications from a Fanfold database (`TACK_FANFOLD_DB`) and recruiter email updates from Gmail (`TACK_GMAIL=1`).
- Full offline support: Includes a bundled profile (Avery Quinn), 40 sample job postings, a 24-application history, and programmatic fallbacks for all eight model tasks.
- Responsive layout: Every view includes dedicated loading, empty, and error states, scaling cleanly from 1440 px down to 390 px.

## How the model is used

- Model connection: Connects to Gemini through its OpenAI-compatible endpoint (`coach/src/llm.ts`), tested with `gemini-3.5-flash-lite`. Enforces JSON schema output, schema validation and repair, on-disk caching keyed by request hash, rate limiting (12 requests per minute by default), automatic retry with exponential backoff on 429 and 5xx responses, and trace events emitted for each call.
- The eight model tasks:
  1. `intake.resume`: Extracts background details from an uploaded PDF or pasted text.
  2. `intake.roles`: Recommends adjacent career transitions.
  3. `gap.extract`: Identifies requested skills from job descriptions with quotes.
  4. `plan.wording`: Writes task names, weekly checkpoint goals, and learning queries.
  5. `portfolio.briefs`: Drafts project outlines, milestones, and deliverables.
  6. `interview.questions`: Writes relevant interview questions based on postings and skill gaps.
  7. `interview.judge`: Evaluates candidate interview answers against rubric criteria.
  8. `kit.tailor`: Customizes résumé bullets and prep materials for a specific posting.
- What code handles instead of the model: Finding and sorting job postings; computing all statistics and metrics (demand, priority, readiness, fit, hours, dates, streaks, response rates, lift, confidence, and overall interview scores); distributing plan tasks and running replans; writing tracker takeaway sentences; ranking next applications via Thompson sampling; verifying quote authenticity; and generating the daily brief. The only numbers the model produces are initial résumé skill ratings (1 to 5, editable on the Start screen), 1 to 5 interview rubric marks, and role overlap estimates.
- Guardrails on model output: All quotes must be found word-for-word in their source text (the résumé, job description, or candidate answer) or code removes them. Upgraded interview answers and tailored application bullets are restricted to facts explicitly mentioned by the candidate.

## Numbers

- Board collection: Configured across 60 boards (33 Greenhouse, 18 Ashby, 9 Lever), with all 60 responding successfully. Scanned 10,654 job listings, matched 450 titles for "AI Product Manager", and ingested 40 full postings. Cold harvest took 9.8 s via the command line and 11.0 s during the recorded demo run (querying boards and parsing postings live without cache).
- Location matching: For the target goal of Bengaluru with remote enabled, all 40 selected postings were located in India or open to remote, spread across 20 companies (InMobi, Razorpay, Meesho, Bureau, Sumo Logic, Netomi, UiPath, Sarvam AI, FamPay, Rubrik, Zeta, Glean, GitLab, Glance, Okta, HackerRank, Fivetran, Hevo Data, Mindtickle, and Harvey). Ranking logic ensures US-only remote listings no longer outrank Indian opportunities when remote is enabled.
- Skill-gap calculation: Processing 40 live postings took 64.6 s on a cold run (8 extraction calls kept under the 12-per-minute limit, handling Gemini 503 retries) and approximately 1 s from cache. Extracted 30 to 32 skills, giving the demo profile an initial readiness score of 34 to 37 depending on the postings retrieved.
- Plan generation and updates: Initial plan generation took 8.6 s cold (producing 55 to 60 tasks). Replanning runs entirely in code and is instantaneous.
- Plan updates: Passing the week 1 checkpoint increased readiness from 36 to 38 during the recorded session. Marking the checkpoint as "not yet" and replanning added a review block, removed one low-priority task that could no longer fit, and delayed 12 tasks.
- Mock interview evaluation: A 79-word candidate answer received an overall score of 80/100 under the rubric.
- Test coverage and packaging: 112 automated tests passing (`cd coach && npm test`), clean UI type checks and builds, and desktop builds (`npm run dist`) producing `.dmg` and `.zip` installers of roughly 120 MB each. The packaged desktop application starts the coach server in about 0.7 s.
- Demo recording: 2:46 runtime at 1920x1080 (H.264, 24 MB), recorded in a single continuous take using Chromium at 1440x900. Job boards were queried live; model calls were served from the local disk cache populated during warm-up runs to remove waiting delays. Only the 11.0 s harvest step was sped up (1.6x, labeled in video).

## Architecture

- `coach/`: Node 22 TypeScript server with zero third-party runtime dependencies (uses native `node:http`, `node:sqlite`, and `fetch`), exposing a JSON API under `/api`, an SSE event stream, and static UI hosting.
- `ui/`: Single-page application built with Vite and React 19, styled using standard CSS tokens and animations, communicating exclusively with `/api`.
- `engine/`: Scrapers for job boards and résumé parsing vendored directly from Fanfold without modifications; called solely by `coach/src/engine-live.ts`.
- `desktop/`: Electron wrapper that launches the coach backend and displays the frontend; `coach/bin/mcp.ts` exposes the same capabilities over stdio for MCP clients.
- State storage: A single SQLite document store alongside file-based caches for LLM responses and scraped job postings, saved inside `state/` (or the desktop app's application data folder).

## Run it

Requires Node 22.18 or higher. Add your model API key to a `.env` file at the root of the repository:

```bash
GEMINI_API_KEY=your_key_here
```

You can also use `TACK_MODEL_KEY`, and set `TACK_MODEL_URL` if pointing to an alternate OpenAI-compatible endpoint.

### Web

```bash
cd ui && npm install && npm run build
node --no-warnings coach/bin/serve.ts
```

Open http://127.0.0.1:4400 in your browser. Click "Load the demo person" on the Start screen to populate all screens without needing to upload a résumé.

### Desktop

For macOS on Apple silicon:

```bash
cd ui && npm install && npm run build
cd desktop && npm install && npm run dist
```

Installers are generated inside `desktop/out/` as a `.dmg` and `.zip`. To run in development mode:

```bash
cd desktop && npm run dev
```

### MCP

Add Tack to your MCP client configuration:

```json
{
  "command": "node",
  "args": ["--no-warnings", "/abs/path/tack/coach/bin/mcp.ts"]
}
```

Refer to `docs/MCP.md` for complete configuration options.

### Tests and demo scripts

Run tests and type checks:

```bash
cd coach && npm test
cd ui && npx tsc --noEmit && npm run build
```

Record and render the demo video:

```bash
PLAYWRIGHT=/abs/path/playwright/index.mjs node submission/video/record.mjs final
node submission/video/render.mjs final
```

## Limits

- The macOS desktop binary uses ad-hoc code signing; Gatekeeper will require approval on first launch (right-click the app and choose Open).
- Gmail integration for reading recruiter responses requires Google API credentials and setting `TACK_GMAIL=1`; it is disabled by default, so demo replies are updated manually or read from sample data.
- Tack prepares application materials rather than submitting them directly to job sites; completed materials are copied by the user (or handled via Fanfold, where users review and confirm each answer).
- Application trends in the demo are calculated from sample records (the bundled profile's 24 applications, labeled as "sample" in the cards and the "What gets replies" panel).
- Using the free Gemini API tier (15 requests per minute) causes an initial uncached gap calculation to take roughly one minute; subsequent runs pull from the local disk cache.
- Board harvesting searches a fixed directory of 60 company boards; target roles with few listings across those specific companies will return fewer than 40 postings.

## Built on

- The ATS job-board parsers and résumé extraction utilities were vendored without alterations from Fanfold (an earlier browser agent project by the author) located under `engine/`.
- All other components—including the coach server, React interface, Electron desktop wrapper, MCP server, gap calculation math, study planner, interview evaluation rubric, and application feedback tracker—were created during the hackathon.
