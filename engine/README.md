# Fanfold

*fan·fold* — paper folded in a continuous accordion, so one sheet opens page after page. Ask once; it fans out across the web and folds the results back into one clean list.

A generalist agent that works inside a real Chrome, driven by the Chrome
DevTools Protocol and structural page understanding rather than a
screenshot loop.

An observation of a typical page is **~120–400 tokens and about 1–2 ms** —
a ref-annotated accessibility tree computed in one DOM pass, not an image
the model has to interpret.

```
url: https://news.example/jobs
- searchbox "Search by title" [ref=e3]
- combobox "Posted within" [ref=e5]: "Past 24 hours"
- checkbox "Remote only" [ref=e6] [checked=false]
- button "Search" [ref=e7]
- button "Saved searches" [ref=e8] [disabled]
```

## Running it

Requires Node 22.18+ (for native TypeScript and `node:sqlite`; CI runs 24)
and Chrome. There are no runtime npm dependencies; `npm install` only fetches
TypeScript and Node's type definitions for `npm run typecheck`.

```bash
cp ../.env.example .env        # then set OPENROUTER_API_KEY
npm start                      # opens the UI and prints a tokenized local URL
npm start -- --headless        # no visible window
npm start -- --attach 9222     # drive a Chrome already on that loopback port
```

The agent runs Chrome against a profile it owns, in its state directory:
`~/Library/Application Support/browser-agent` on macOS,
`%LOCALAPPDATA%\browser-agent` on Windows, `$XDG_DATA_HOME/browser-agent` on
Linux, or `BROWSER_AGENT_STATE_DIR` when set. The profile is `chrome-profile`
inside it. Sign in to a
site once in that window and the session persists across restarts. It never
has access to your everyday browsing, passwords, or cookies — only the
accounts you deliberately sign it into.

### Without an OpenRouter key

You can start Fanfold without any model key. The UI, Review, and the MCP endpoint still work, so another agent can drive it. Only Fanfold's own agent and its scheduled workers need a model. Without one, the scheduler stays off and a task will tell you how to configure a model.

You can use any OpenAI-compatible chat-completions endpoint instead of OpenRouter. Set these in `.env`:

| Setting | What it is |
|---|---|
| `FANFOLD_MODEL_URL` | The endpoint's base URL (ending in `/v1`) or its full `/chat/completions` URL |
| `FANFOLD_MODEL_KEY` | Its key, if it needs one. The OpenRouter key is never sent to it |
| `FANFOLD_MODEL_STEP`, `FANFOLD_MODEL_PLAN`, `FANFOLD_MODEL_VISION` | Model ids per tier at that endpoint. Every agent step uses the plan tier |

If you have Claude Code installed and signed in, `bin/model-bridge.ts` runs this endpoint locally on 127.0.0.1. It answers each call using `claude -p` without any tools, supports only Haiku or Sonnet, follows each request's JSON schema, cuts off responses at `max_tokens` just like a provider does, and handles up to six calls at once by default. For safety, it only talks to programs on this computer—it rejects requests coming from a web page, requests that name another host, and anything that isn't JSON. Each time it starts, it generates and prints a fresh key, and it will only answer requests that include it. Pass that key to Fanfold as `FANFOLD_MODEL_KEY`. If you'd rather use your own key, set it with `--key` or `FANFOLD_BRIDGE_KEY`.

```bash
node --no-warnings bin/model-bridge.ts --port 4340
# it prints the key for this run
FANFOLD_MODEL_URL=http://127.0.0.1:4340/v1 FANFOLD_MODEL_KEY=<the key it printed> FANFOLD_MODEL_PLAN=haiku FANFOLD_MODEL_STEP=haiku npm start
```

Cost figures in the ledger are what the claude CLI reports at list price.

### Selecting a dedicated Chrome

`npm run browser` prints the selected executable. To use an installed
[Chrome for Testing](https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing)
binary, configure its **executable**, not the `.app` directory:

```bash
npm run browser -- --path "/absolute/path/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
```

The selection is stored in `browser.json` in the state directory
and applies to the app, daemon, diagnostics, benchmarks and browser tests.
`BA_CHROME_PATH` overrides it for a command; an explicit `launchChrome` option
takes precedence over both. With no configuration, regular installed Google
Chrome is used. A missing configured binary is an error, not a silent fallback.
Restart an already-running agent after changing the selection. The agent's
profile is retained; do not select an older Chrome against a newer profile.
Pinned Chrome for Testing builds do not auto-update: install security updates
from Google's official distribution and explicitly select the newer build.

**Northlight conflict:** on this Mac Northlight's reloader killed other regular
Google Chrome instances, including ones with their own dedicated profiles.
Use a separate Chrome for Testing binary, or quit Northlight first. Do not
reuse Northlight's profile or weaken Chrome's sandbox to work around this.

One measured caveat, because it surprised me: a session created seconds
before Chrome is *killed* does not survive. Chrome commits its cookie store on
a timer, and a SIGKILL takes whatever is still in memory with it. An orderly
restart keeps the session; a hard kill right after signing in comes back
signed out. Nothing in this code can change that, and in practice the sessions
that matter were written to disk long before. Downloads land in
`downloads` inside the state directory.

```bash
npm run test:unit              # the browser-free suite
npm run test:browser           # against a real Chrome
npm run eval                   # action-selection eval across model tiers
npm run bench                  # observation cost on ten real pages
npm run learn:cycle            # one real failure → lesson → gate → rerun, with the real model
npm run screen:demo            # resume-backed job screening with the real model
npm run ba -- snapshot -i      # drive the same session by hand
```

## Starting, stopping, restarting

`npm start` opens the UI in your browser and prints the tokenized URL it
opened. Ctrl-C stops it: the scheduler releases its lease, the browser is
closed gracefully so its cookie store is written, and the database is
closed. Nothing else needs doing.

On the next start, the app looks at what the last one left behind and says
so before it does anything else:

```
From a previous session: 1 run(s) left open, 1 action(s) attempted but never confirmed.
These are listed in the UI; the unconfirmed ones are worth checking by hand.
```

"Attempted but never confirmed" is the honest state of an outbound action —
a send, a comment — that was dispatched when the browser or the process died
before the outcome was seen. The app does not retry these on its own, and it
does not mark them done; they are shown under **Needs a look** in the UI so a
person can check the page and decide. Scheduled workers resume on their own:
a slot missed while the app was off is skipped, not run late, and never run
twice.

## Connecting Gmail and Calendar

Connectors go through [Composio](https://composio.dev), which holds the
OAuth relationship — its own Google project, consent screens and token
refresh — so this app never keeps a Google refresh token on the device and
does not need Google's restricted-scope verification to be run for it.

```bash
# app/.env
COMPOSIO_API_KEY=...            # from app.composio.dev
# optional: reuse auth configs you created in the Composio dashboard
# COMPOSIO_GMAIL_AUTH_CONFIG_ID=ac_...
# COMPOSIO_CALENDAR_AUTH_CONFIG_ID=ac_...
```

Then `npm start`, and under **Connectors** connect Gmail and Calendar each
once. Consent happens on Composio's hosted screen; this app polls the
account until Composio reports it `ACTIVE`, then immediately executes one
real read against it (`GMAIL_GET_PROFILE`, `GOOGLECALENDAR_LIST_CALENDARS`)
so "connected" is never shown until "working" has been checked. A declined
consent surfaces as an error rather than a spinner.

What the agent may do is derived from the account's granted scopes with the
same rule as the direct connector: reading is offered when the account is
active; drafting only when a scope that permits it is actually listed,
because every scope that can draft can also send. There is still no send
action in this codebase, whichever provider is behind it.

The direct Google OAuth client path (`GOOGLE_CLIENT_ID`) remains as a
fallback and is used when no Composio key is set.

## Design

### Refs are leases, not handles

An observation mints a `pageStateId`, and its refs are valid only against
it. An action carrying a stale state id, an unknown ref, or a ref whose
element has changed role or accessible name **fails locally** rather than
clicking whatever now occupies that position. A re-render that shifts
element order is the classic way an agent clicks the wrong button; here it
is a typed failure, not a silent misfire.

### Policy sits outside the model

Every action passes the policy engine between the model and the browser.
Sensitivity is derived from the action and its target, never from the
model's own account of what it is doing.

This placement was not a precaution — it was measured. An earlier
action-selection eval had all three model tiers clicking **Send** on a
message to a third party when the draft was already in the box, despite a
system prompt forbidding it. Sharpening the prompt fixed all twelve cases
on all three tiers. A prompt that holds on twelve cases is not a guarantee
when the input contains text a web page wrote, so the same rule lives in
code where nothing in a prompt or a page can reach it.

### Page text is data

Everything a page authored is a distinct type that cannot reach a prompt
without being fenced. Role markers, block terminators, control characters
and bidi overrides are defused on the way through, so a page cannot close
its own data block or impersonate a system turn.

### Side effects are journalled before they happen

An action that can affect the outside world records its intent under a key
derived from run, step, target and content, and settles it afterwards. A
crash leaves exactly one row saying what may have happened — the difference
between checking one action by hand and checking a whole batch.

### Connectors are actions, and their output is untrusted

An API keeps working while the machine is asleep and is faster than driving a
web version of the same thing, so `gmail_search`, `gmail_draft`,
`calendar_events` and `calendar_free_slots` are part of the action space —
offered only when actually connected, and refused as unavailable otherwise.

There is no send action, and the boundary is that `Gmail` has no send
method — a property of this code. It is **not** the scope: `gmail.compose` is
the narrowest scope Google offers for creating drafts and it also authorises
sending. So drafting is opt-in, and the default grant is read-only, which is
the part that genuinely cannot send.

Message headers are built by concatenation, which makes them an injection
site. A recipient or subject containing a control character is refused rather
than stripped — a newline in an address is never a typo, and silently
removing it hides whatever put it there.

Each action is gated on what the token **actually grants**, read from the
token rather than from what was asked for at consent — a user can decline
individual scopes, and a token minted before drafting was enabled does not
acquire the scope because the app now asks for it. A read-only grant offers
no drafting action at all.

"What's on my calendar tomorrow" does not open a browser. The browser starts
the first time a page is genuinely needed, and not before.

Everything a connector returns is fenced exactly like page content. An inbox
is a **more** direct route for a stranger to reach the agent than a web page
is, because the user never chose to open it.

### Authorisation reads the field that decides

A recipient-scoped grant is only as good as the identity it matches. Identity
comes from the URL path of a conversation, or the **value** of an addressee
control — To, Cc, Bcc — never from a label, nearby text, or the page body.

Where a page offers both, they must name the same person — as whole
identities, not on a shared token. A thread at `/messages/priya-sharma` whose
To field reads `priya.patel@example.test` shares a first name and is a
different person, so it resolves to unknown. Only identity-free material is
ignored when comparing: opaque ids and numeric suffixes, which real profile
URLs append. Two addressee fields that disagree
resolve to nothing as well, because a multi-recipient send is not covered by a
single-recipient grant — and an undetermined recipient means a person decides.

Before anything that reaches a person or cannot be undone, the page is observed
again and the destination re-checked. A recipient swapped between the
authorisation and the click stops the send and does not spend the grant.

### Capacity is claimed, not checked

A budget checked before an action and spent after it is a statistic, not a
limit: two concurrent runs both pass the check and both act. Measured, before
this was fixed — two parallel runs sharing a one-use Send grant both clicked
Send, and a `perDay: 1` cap recorded two sends.

Capacity is now claimed before actuation and settled after. A claim counts
against the cap while in flight. Settlement distinguishes what is known: a
failure that happened before any input was dispatched gives the capacity
back, while a transport loss or timeout is settled as **unknown** and keeps
counting. Assuming an uncertain send did not happen is how someone gets
messaged twice.

### Learning proposes, evals promote

The reflector reads finished runs and proposes lessons and skills. Nothing
it writes takes effect until the gate has measured that it does not make
the agent worse, because the failure mode of a self-improving system is not
that it stops improving — it is that it degrades while reporting success.

The gate has three arms, and each exists because something got through
without it:

1. A deterministic screen refuses any lesson touching approval, safeguards
   or credentials. Lessons describe how a site behaves; since they are
   derived from page content, treating one as a permission change hands
   that decision to whoever wrote the page.
2. A saturated baseline returns **unproven** rather than promoting on
   evidence that cannot distinguish. The first version of this gate
   approved a lesson saying a finished draft counts as approval, because
   the suite was already at 12/12 and the score did not move.
3. A lesson applied to every site must demonstrably help, not merely fail
   to hurt — its cost is paid on every step forever.

A lesson the suite cannot measure stays `unproven` and out of recall. The way
in is new evidence, not more confidence in the same evidence: when a run
failed at a step and then recovered on the same page, that trajectory holds
ground truth, and it becomes an eval case. Each reflection pass derives those
cases and re-gates the unproven lessons against the enlarged suite.

Reflection runs on the scheduler, not on a button.

### Skills replay without the model

A skill step never names an element by ref; it names it by role and
accessible name, resolved fresh each replay. Ambiguity is a failure, not a
coin flip. Checkpoints are structural — a role present, a count met, a URL
shape — never a screenshot hash, because antialiasing, an animation frame
or a timestamp all change pixels while the page is fine, and a pixel
checkpoint is a false-negative generator wired into the quarantine rule.

Policy applies to a replayed action exactly as to a chosen one. A learned
skill is not a way to pre-authorise anything.

### Memory: four stores, one of them exact

| Store | Keyed by | Why |
|---|---|---|
| Skills | (domain, intent) | Replayable programs, not remembered selectors |
| Lessons | (domain, task type) + BM25 | Append-only; revising supersedes |
| Episodic | exact identity | **Never fuzzy** |
| Documents | BM25 with stemming | Resume, PDFs, writing samples |

An outside agent importing a file with `files_add` can use it right away only if it is clearly your résumé, CV, or cover letter, meaning it includes your profile name and its file name or headings show what it is. Fanfold keeps any other file, but no agent can read, search, or attach it until you approve it. Fanfold asks you once, either in your host app or under Documents in its own window. Once you allow it, it counts as your own file. See [docs/mcp.md](../docs/mcp.md) for details.

When a form asks something that no saved fact, saved answer, or résumé covers, an outside agent calls `job_ask`. Fanfold asks you each question once, in your host app or on the Review page in its own window. It saves your answer to the answer bank and reuses it on every later form. Parallel sessions asking the same question share one prompt, and a waiting question pauses only the job that asked it. Fanfold never asks for passwords, one-time codes, card, bank or account numbers, or government ID numbers. See [docs/mcp.md](../docs/mcp.md).

Fanfold saves what it learns about each site in plain files you can read. They are stored as an Open Knowledge Format bundle in `knowledge/` next to the database, with one markdown file per site. You can read, edit, and share these files, and Fanfold picks up your changes before the next agent visits that site. [docs/mcp.md](../docs/mcp.md) explains how.

Episodic identity is a unique constraint rather than a distance, because
its whole job is that the same person is never surfaced or contacted twice,
and a similarity threshold eventually ranks two people as one. Recording a
second contact to someone already contacted throws.

### Workers: a missed slot is not a debt

Three slots passing while the laptop is shut produce one decision, not a
backlog. Queuing missed work means opening a laptop after a weekend fires a
burst of outbound activity. Local times resolve through an iterative search
rather than a fixed offset, so a schedule stays at 9am across a DST change.

Rate limiting here is about respecting documented limits and not hammering
a service. It is not a disguise, and no knob is for making automation look
human — that is circumvention of a safeguard and is out of scope.

## Model tiers

Verified against the live OpenRouter models endpoint, with a real
completion per model ID:

| Tier | Model | In / Out per 1M | Eval | p50 |
|---|---|---|---|---|
| step | `deepseek-v4-flash-0731` | $0.06 / $0.12 | 75% | 7.4s |
| vision | `deepseek-v4.1-flash` | $0.15 / $0.60 | 92% | 18.5s |
| plan | `deepseek-v4-pro-0813` | $0.579 / $1.738 | 92% | 1.8s |

Two findings changed the plan. The cheap text Flash is **not** the right
inner-loop model — Pro is both more accurate and roughly four times faster,
at about $0.0005 a call. And vision is not a premium tier: the
vision-capable Flash costs more than the text one while the planning model
cannot see at all, so vision is a cheap triggered perception step rather
than an escalation. Since Pro cannot see, a visual observation is a typed
evidence record that Pro reasons over — and a high-risk action never rests
on an unverified visual summary.

Prices live in a versioned book, and every ledger entry records which
version and which rate period priced it.

## Layout

```
src/cdp/        pipe transport, domain allow-list, launcher, WebSocket attach
src/observe/    in-page serializer, page controller, renderer, BrowserRuntime
src/policy/     untrusted-text boundary, policy engine
src/agent/      action contract, loop, replay, reflector, approvals, fan-out, objectives
src/jobs/       site policy catalog, jobs and applications, profile and answer bank, ATS APIs
src/memory/     four stores, BM25 retrieval
src/eval/       action-selection eval, promotion gate
src/workers/    scheduling, rate governance, worker runner
src/billing/    credits ledger
src/connectors/ encrypted secrets; Composio (Gmail, Calendar); direct Google OAuth fallback
src/server/     local API and the UI (chat, workers, applications, review, profile, playbooks)
evals/          21 action-selection cases
```

`NOTES.md` records measured behaviours worth not rediscovering, including
the launcher failure modes. [chrome-lifecycle.md](../docs/troubleshooting/chrome-lifecycle.md) corrects the earlier attribution
of repeated Chrome exits to a sandbox.

## What is implemented, and what is not

Implemented and tested without a browser:

| Area | State |
|---|---|
| Observation, refs-as-leases, drift | Implemented; browser suite passes when Chrome cooperates |
| Fail-closed action classification | Implemented, two-sided tests |
| Capability grants (scoped, revocable) | Implemented |
| Approvals with safe resumption | Implemented |
| Rate governance before outbound actions | Implemented |
| Worker scheduling (recurs on its own, starts its own browser) | Implemented |
| Concurrent budget enforcement (atomic claims) | Implemented |
| Lesson lifecycle + promotion gate | Implemented |
| Eval cases derived from real failures | Implemented |
| Periodic offline reflection | Implemented |
| Skill replay | Implemented |
| Document import, PDF extraction, retrieval | Implemented |
| Credits ledger | Implemented |
| Gmail/Calendar via **Composio** (preferred) | Implemented: consent link, status polling, tool execution, real reachability check. **No live account connected yet** |
| Google OAuth + Gmail/Calendar clients (direct) | Implemented and kept as the fallback for anyone with their own OAuth client |
| Gmail/Calendar inside the agent's action space | Implemented (`gmail_search`, `gmail_draft`, `calendar_events`, `calendar_free_slots`) |
| Reflection cancelled on lease loss | Implemented |
| Connector-only tasks without a browser | Implemented — Chrome opens only when a page is needed |
| Tools gated on the token's actual scopes | Implemented |
| JavaScript dialogs (alert/confirm/prompt/beforeunload) | Implemented; answered conservatively and reported |
| Tabs a click opened, and switching between them | Implemented |
| File upload, restricted to the user's imported documents | Implemented |
| Files an outside agent imports: the user's own résumé, CV or cover letter at once, any other file kept until the user allows it | Implemented |
| Downloads saved to a known directory and reported | Implemented |
| Real-Chrome reliability | Full fixture suite and launch/crash recovery verified with a dedicated runtime; sustained account-backed use still pending |
| Site policy catalog (auto / prepare / never, challenge downgrade) | Implemented; consulted by the policy engine before any gate or grant |
| Jobs and applications, one live application per job | Implemented; enforced by a partial unique index |
| Profile facts, answer bank, preferences | Implemented; only user-confirmed facts reach a prompt |
| Questions only you can answer (`job_ask`): asked once, saved to the answer bank, and reused on later forms | Implemented |
| Workers v2 (sites, caps, autonomy, weekdays, status reasons) | Implemented; enabling a worker mints its scoped grant |
| Public ATS job-board discovery (Greenhouse, Lever, Ashby, Workable) | Implemented |

Deferred, and not claimed:

- **No real Google account has been connected.** The OAuth flow, token
  encryption, API clients, action space and policy classification are written
  and tested against mocks, but nobody has completed a consent flow, so the
  end-to-end path is unproven. Gmail's restricted scopes also need Google
  verification and a security assessment before a shipped product can use them.
- **The job-search surfaces are new.** Workers v2, applications, the review
  queue, the profile and the site catalog are implemented and tested against
  fixtures and fakes; none has yet run against a live ATS or job board.
  Extension mode and a shared playbook registry are planned and not built.
- **Phase 0's exit criteria are partly met.** Browser fixtures cover dialogs,
  tabs, uploads, downloads, trace replay and long tasks across deliberate
  browser kills. The full browser suite now passes and the ten-URL observation
  benchmark completes with a dedicated runtime. That is engineering evidence,
  not proof of sustained reliability on the user's live accounts.
- **Retrieval is lexical**, not semantic. A query sharing no vocabulary with
  a relevant chunk will miss it. `Embedder` is the seam for vectors when an
  eval shows lexical retrieval losing something.
- **The eval suite is small, and the gate is only as good as it.** `npm run eval`
  reports its size and pass rate; the number is not written here because it
  went stale. One real learning cycle has been run end to end with the real
  model (`npm run learn:cycle`): the reflector proposed a lesson from a
  failure-and-recovery on a job page, and the gate **refused** it — it named a
  control that is not visible until the page is scrolled, and with it present
  the model stopped scrolling and regressed two cases. That is the gate doing
  its job. No lesson has yet been promoted and then shown to improve a later
  run; that needs more cycles on real usage, and the script records each one.
  The cycle also caught the model declaring a task done without acting, twice
  in four runs; that failure is now case 21 of the suite.

## What "done" would mean, and what is actually verified

The target is a **local personal alpha**: one user, one Mac, billing and
multi-user deferred. [DONE_GATES.md](../docs/design/DONE_GATES.md) holds the acceptance criteria. Against
those, honestly:

| Gate | State |
|---|---|
| Outbound truth and safety | Implemented and tested. No potentially-dispatched failure can be reported as a completed send; capacity and the effect journal agree; nothing is retried automatically. |
| Real Chrome reliability | **Fixture gate verified.** Dedicated Chrome survives headful/headless liveness checks; the full suite passes, including deliberate browser/renderer crashes. Sustained live-account use remains unverified. See [chrome-lifecycle.md](../docs/troubleshooting/chrome-lifecycle.md). |
| Live Google connector | **Not verified.** Mock and loopback tests pass; no real account has been connected. `verify` and the UI now make the call rather than reading the scope list — but nobody has run it against a real account, so the gate is open. |
| Intended user workflow | **Engineering evidence in place, live use not yet.** Resume-backed screening runs end to end with the real model (`npm run screen:demo`); the approved-reply flow — draft, stop, edit, send verbatim, journal, refuse a repeat — passes against a real page; contact dedupe is wired so the same person cannot be messaged twice even under a grant. Not yet: your accounts, a scheduled worker in daily use. |
| Eval, learning, cost | **One real cycle measured.** Failure → derived case → proposal → gate, with the real model; the gate refused the candidate for regressing two cases. Not yet shown: a promoted lesson improving a later run. |
| Handoff quality | This document states no test counts, because they went stale twice. `npm run verify` reports the current numbers. |

Nothing in this document should be read as saying the browser layer or the
connector works in production. They are tested against fixtures and mocks,
which is a different claim.

## Real-Chrome reliability

The repeated short-lived Chrome instances were traced on 2026-09-16 to
**Northlight's process reloader**, not an agent-only sandbox. Its local log
records successful TERM signals to the exact PIDs in the user's failing
headful and headless diagnostic. Regular Chrome subsequently survived with
Northlight stopped; a dedicated Chrome for Testing survived while Northlight
was still running. See [chrome-lifecycle.md](../docs/troubleshooting/chrome-lifecycle.md) for the evidence and validation.

Earlier explanations attributing every clean exit to stale singleton files,
sibling teardown or renderer crashes were not established by the exit code.
An orderly external termination can also exit with code zero. A lost browser
is an observed outcome, not a root-cause classification.

Recovery remains necessary for actual crashes, but it must not conceal a
browser that is continuously killed. The launcher survival regression uses
a bare Page and a single launch, without the resilient runtime or retries.
Potentially dispatched external writes remain unknown and are never retried.

```bash
npm run diagnose -- launch    # headful/headless liveness; uses the agent profile
npm run diagnose             # guarded navigation and orderly restart; temporary profiles
npm run test:browser          # real-browser regressions
npm run bench                # observation cost across public pages
npm run verify               # tests plus connector acceptance gates
```

`diagnose` prints the selected executable, CDP events and process exits. For
an unexpected launch-flow exit it also checks the local Northlight log for a
successful TERM to that exact PID during that run. Absence of such a record
is not evidence that a sandbox or Northlight caused the loss.

`bench` measures each URL in a fresh browser. Its success means navigation
and observation completed, not that a search engine served useful results
instead of a challenge. It measures observation overhead, not end-to-end
agent latency.

## LinkedIn

The agent works through the user's own logged-in session, in a browser the
user signed in to themselves. Ordinary logged-in reading is not something
this document describes as prohibited.

What LinkedIn's terms do restrict is third-party automated access and
activity, and scraping. That other products do this demonstrates
feasibility, not permission. So the boundaries in this design are:

- Applications on LinkedIn and Indeed are always "prepare, you press
  Submit": the site catalog makes that the policy engine's answer before any
  gate setting or grant is consulted, so no autonomy level reaches a Submit
  button on either site.
- Other public writes — messages, comments, connection requests — are
  reviewable by default, and go out unattended only under a capability
  grant that names the site, the action class, a use budget and an expiry,
  and can be revoked.
- Every outbound action is audited and deduplicated by exact identity, so
  the same person is never contacted twice.
- No evasion: no CAPTCHA bypass, no timing designed to look human, no
  fingerprint manipulation. Rate limiting here is about respecting
  documented limits and not hammering a service.
- A commercial product built on this needs legal and platform review before
  shipping. That is a business decision, not something the code can settle.
