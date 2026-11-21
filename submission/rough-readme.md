# Tack

Tack is a career pivot coach. It reads live job postings, maps them against your resume with the exact lines as proof, plans the move week by week, drills interviews, applies for you in a real browser, and learns from which applications get replies. Built in one day for the Product Space Agentic AI Hackathon, problem statement 05 (Career pivot coach).

## What it does

| Requirement | How Tack meets it |
|---|---|
| Resume and target-role intake | Upload a PDF or paste text. Every skill it finds must carry a quote from the resume, or it is dropped. It also suggests five roles next door. |
| Skill-gap map from real job descriptions | Reads 40 live postings from 60 real company job boards (Greenhouse, Ashby, Lever). Each skill carries the exact line from the posting. Demand, need, have, priority and readiness are computed in code. |
| Week-by-week learning plan | Code schedules skills into weeks by priority, prerequisites and your weekly hours. Checkpoints each week. Calendar export. |
| Portfolio projects matched to the gaps | Three projects, each covering at least two open gaps, tied to plan weeks and to quotes from postings. |
| Mock interviews scored against a rubric | Five questions from the target postings. Five fixed criteria, each scored 1 to 5 with a reason and a quote of your own words. A stronger answer using only your facts, and a follow-up question. |
| Progress tracking that adjusts the plan | Ticking tasks and passing checkpoints moves readiness. Replan moves late work and shows what moved and why. |
| Application tracker that learns which roles get responses | Response rates per role family, seniority, company size, source and fit band, with confidence. Ranks what to apply to next using Thompson sampling. |

## Beyond the brief

- Applies for you: opens a real Chrome through the Fanfold engine, fills the whole form, attaches the resume and submits. Several applications run in parallel, one browser session each.
- Reads replies: searches your mail for each company, sorts each message (interview, rejection, offer, auto-reply), updates the tracker, and the learning updates.
- Application kit: tailors resume bullets to one posting. Each bullet shows the resume line it came from. Bullets that cannot be traced are dropped.
- Apply queue that never applies twice, a "needs you" list for captchas, logins and missing answers, and a standing consent setting.
- Desktop app for macOS, a hosted web preview, and an MCP server with 8 tools.

## Autopilot

Switch it on and it runs the whole loop on a schedule (default every 12 hours): read new postings, rebuild the gap map, pick the best ones up to a daily cap, prepare kits, apply in parallel, check replies, replan, and write a run report. It resumes by itself after a crash. Settings: interval, daily cap, minimum fit, exclusions, quiet hours, and whether applications need your approval (off by default).

## How the model is used

- Gemini through its OpenAI-compatible endpoint, with JSON schemas, a disk cache, one shared request budget and retries.
- The model reads and judges: resume parsing, skill extraction, plan wording, project briefs, interview questions and scoring, kit tailoring, reply sorting.
- Code does the maths: finding and ranking postings, demand, readiness, fit, schedules, response rates, lift, what to apply to next.
- Every quote from the model is checked to be a real substring of its source. If not, it is dropped.
- Everything has a no-model fallback, so nothing fails when the model is down.

## Numbers

- 60 company boards answered; 10,654 roles scanned; 450 matched "AI Product Manager"; 40 read in full in about 11 seconds.
- Gap map from 40 postings: about 12 seconds on the fast model.
- One practice application: about 17 seconds. Three in parallel: 35 to 71 seconds.
- Real forms filled but never submitted: Greenhouse (InMobi) 8 of 11 fields, all 3 required; Lever (Meesho) 12 of 21, 8 of 14 required; Ashby (Sarvam AI) 6 of 7, all 4 required. Resume attached in all three.
- 175 automated tests pass.

## Architecture

- engine/: Fanfold, my earlier browser agent, copied in. Reads job boards, parses resumes, drives Chrome, reads mail.
- coach/: Node 22 TypeScript server with no runtime dependencies. SQLite store. All coaching logic.
- ui/: React and Vite. Nine screens.
- desktop/: Electron shell that starts the coach.

## Run it

```bash
cd ui && npm ci && npm run build && cd ..
echo "GEMINI_API_KEY=your-key" > .env
node --no-warnings coach/bin/serve.ts
```

Open http://127.0.0.1:4400 and press "Load the demo person", or add your own resume.

Desktop app:

```bash
cd desktop && npm ci && npm run dist
```

Hosted mode: see docs/DEPLOY.md. MCP server: see docs/MCP.md. Tests:

```bash
cd coach && npm test
```

## Limits

- The demo person is fictional. Demo applications go to a local practice form and demo replies come from a sample mailbox. With a real person, Apply targets the real posting.
- Real mail needs you to connect Gmail once. This path was checked up to Google's sign-in page, not against a real inbox.
- On real forms, fields like gender, pay and relocation are left for you.
- Browser windows cascade instead of tiling side by side.
- The macOS build is not signed. Right-click and choose Open the first time.
- The hosted preview cannot apply or read mail; those need the desktop app.
- The free Gemini tier is slow and has a small daily limit. A paid key makes everything faster.

## Built on

The job-board reader, resume parser and browser automation come from Fanfold, my own earlier project, copied into engine/. Everything else was built during the hackathon.
