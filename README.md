# Tack

Tack is a career pivot coach. It checks live job ads, compares them to your resume using exact lines as proof, sets up a week-by-week plan, runs practice interviews, fills out job applications for you in a real browser, and learns from the jobs that reply. I built it in one day for the Product Space Agentic AI Hackathon, problem statement 05 (Career pivot coach).

- Web preview: https://tack-black.vercel.app
- Desktop app and demo video: https://github.com/rishavnaskar/tack/releases/tag/v0.1.0

## What it does

| Requirement | How Tack meets it |
|---|---|
| Resume and target-role intake | Upload a PDF or paste in text. Every skill it picks up must include an exact quote from your resume, or the tool drops it. It also recommends five related roles next door. |
| Skill-gap map from real job descriptions | Pulls 40 live job posts from 60 real company job boards (Greenhouse, Ashby, Lever). Every skill links directly to an exact line in the job post. Code calculates demand, need, have, priority, and readiness. |
| Week-by-week learning plan | Code maps skills into weekly schedules based on priority, prerequisites, and how many hours you have each week. Includes weekly checkpoints and lets you export to your calendar. |
| Portfolio projects matched to the gaps | Sets up three projects. Each covers at least two open gaps, ties into your weekly plan, and links back to quotes from real job ads. |
| Mock interviews scored against a rubric | Gives you five questions taken from target job posts. Grades each on five fixed criteria from 1 to 5, explains the score, and quotes your own words. It gives you a better answer made only from your facts, plus a follow-up question. |
| Progress tracking that adjusts the plan | Checking off tasks and clearing checkpoints updates your readiness. The replan tool reschedules delayed work and clearly shows what changed and why. |
| Application tracker that learns which roles get responses | Tracks reply rates by role family, seniority, company size, source, and fit band, along with confidence scores. It uses Thompson sampling to rank where you should apply next. |

## Beyond the brief

- Applies for you: Launches a real Chrome window using the Fanfold engine, completes the entire form, adds your resume, and sends it in. It can run multiple applications at once, using a separate browser session for each.
- Reads your replies: Looks through your email for messages from each company, labels each one (interview, rejection, offer, or auto-reply), and updates the tracker and learning model.
- Application kit: Customizes your resume bullets for each specific job. Every bullet points to the exact line in your resume it came from. Any bullet without clear proof is cut out.
- Smart apply queue: Never applies to the same job twice, keeps a "needs you" list for captchas, logins, or blank fields, and includes a standing consent toggle.
- Multi-platform: Works as a desktop app for macOS, a hosted web preview, and an MCP server with 8 tools.

## Autopilot

Turn Autopilot on and it takes care of the full cycle on a timer (every 12 hours by default): it reads fresh job ads, updates your gap map, selects the best matches up to your daily cap, builds your application kits, applies in parallel, checks for email replies, updates the plan, and writes a status report. If it crashes, it starts right back up on its own. You can adjust the run interval, daily cap, minimum fit score, excluded companies, quiet hours, and decide if applications need manual approval (turned off by default).

## How the model is used

- Runs Gemini through an OpenAI-compatible endpoint with JSON schemas, a disk cache, a single shared request budget, and retry logic.
- The model handles language and evaluation: reading resumes, pulling out skills, writing plan text, drafting project briefs, writing and grading interview questions, tailoring kits, and sorting incoming emails.
- Code handles the math: searching and sorting job ads, calculating demand, readiness, fit, schedules, reply rates, score lift, and what to apply to next.
- The app verifies every quote from the model against the original text. If it is not an exact substring, it gets removed.
- Every feature includes a fallback that works without the model, so the app stays up even if the model goes down.

## Numbers

- 60 company boards checked; 10,654 roles scanned; 450 matched "AI Product Manager"; 40 full descriptions read in about 11 seconds.
- Made a complete gap map from 40 postings in about 12 seconds using the fast model.
- Finished one test application in about 17 seconds. Handled three parallel applications in 35 to 71 seconds.
- Filled out real forms without submitting: Greenhouse (InMobi) filled 8 of 11 fields including all 3 required; Lever (Meesho) filled 12 of 21 fields including 8 of 14 required; Ashby (Sarvam AI) filled 6 of 7 fields including all 4 required. Attached the resume in all three cases.
- Passes 176 automated tests.

## Architecture

- engine/: Contains code brought over from Fanfold, my earlier browser agent. It reads job boards, extracts resume text, controls Chrome, and checks email.
- coach/: A Node 22 TypeScript server with zero runtime dependencies. Uses SQLite for storage and runs all coaching logic.
- ui/: Built with React and Vite across nine screens.
- desktop/: An Electron wrapper that launches the coach server.

## Run it

```bash
cd ui && npm ci && npm run build && cd ..
echo "GEMINI_API_KEY=your-key" > .env
node --no-warnings coach/bin/serve.ts
```

Open http://127.0.0.1:4400 in your browser and click "Load the demo person", or paste your own resume.

To build the desktop app:

```bash
cd desktop && npm ci && npm run dist
```

For hosted mode, read docs/DEPLOY.md. For the MCP server, read docs/MCP.md. To run tests:

```bash
cd coach && npm test
```

## Limits

- The sample user is made up. Demo applications fill out a local practice form, and demo replies come from an included test mailbox. Real applications go straight to real job listings.
- Live email checks require connecting your Gmail account once. This flow was tested up to the Google sign-in screen, not on an active personal inbox.
- On live application forms, fields like gender, salary expectations, and relocation preferences are skipped for you to fill out.
- Open browser windows stack on top of each other instead of snapping side by side.
- The macOS build is not signed with an Apple developer certificate. Right-click the app icon and click "Open" the first time you run it.
- The hosted web preview cannot send applications or read your inbox; you need the desktop app for those features.
- The free Gemini tier is slower and comes with tight daily limits. Using a paid API key runs much faster.

## Built on

The job-board scraper, resume reader, and browser automation were copied into engine/ from my earlier project, Fanfold. I wrote the rest of the application during the hackathon.
