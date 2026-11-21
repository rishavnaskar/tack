# Deploying the Tack web preview

Setting `TACK_HOSTED=1` runs the coach as a public web preview. Each visitor gets their own anonymous session. In this mode, automated applying, mail reading, autopilot, and the browser engine are turned off, and the coach cannot spawn any child process. When this flag is unset, local runs and the desktop app work normally.

## Environment

| Variable | Default | What it does |
| --- | --- | --- |
| `TACK_HOSTED` | unset | Set to `1` to turn on hosted mode. |
| `PORT` | `8080` | Port to listen on. Hosted mode listens on `0.0.0.0`. |
| `GEMINI_API_KEY` or `TACK_MODEL_KEY` | none | Model key. Needed to read résumés and extract skills; set it as a secret. |
| `TACK_MODEL_URL`, `TACK_MODEL_FAST`, `TACK_MODEL_SMART` | Gemini's OpenAI-compatible endpoint, `gemini-3.5-flash-lite` | Model endpoint and model names. |
| `TACK_MODEL_RPM` | `12` | Model calls per minute across the whole process. |
| `TACK_MODEL_MAX_WAIT_MS` | `60000` | If the model endpoint asks Tack to wait longer than this, the call fails with 503 instead of waiting. |
| `TACK_STATE_DIR` | `/tmp/tack` | Directory for sessions, caches, and the cookie signing key. |
| `TACK_TRUST_PROXY` | `0` | Number of proxy hops in front of Tack. Headers like `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`, and `X-Request-Id` are only used when this is set. Set `1` behind one proxy. |
| `TACK_SESSION_SECRET` | generated | Secret of at least 32 characters used to sign session cookies. When unset, a key is generated and saved in `<state>/session.key`. |
| `TACK_DOWNLOAD_URL` | unset | Link to the desktop app, shown in the banner and on the landing strip. Hidden when unset. |
| `TACK_MAX_SESSIONS` | `500` | Maximum number of sessions kept at once. |
| `TACK_SESSION_TTL_HOURS` | `24` | A session with no visit for this long is deleted. |
| `TACK_SESSION_IDLE_MINUTES` | `10` | An idle session's database is closed after this long. |
| `TACK_NEW_SESSIONS_PER_IP_HOUR` | `60` | New sessions one address may start in an hour. |
| `TACK_RATE_IP_PER_MINUTE` | `240` | Requests per minute from one address. |
| `TACK_RATE_SESSION_PER_MINUTE` | `120` | Requests per minute from one session. |
| `TACK_SESSION_INFLIGHT` | `4` | Concurrent requests one session may have running at once. |
| `TACK_STREAMS_PER_SESSION`, `TACK_STREAMS_PER_IP` | `4`, `16` | Open trace streams (such as browser tabs). |
| `TACK_MAX_JSON_MB`, `TACK_MAX_RESUME_MB` | `1`, `5` | Largest JSON body, largest résumé file. |
| `TACK_BUDGET_SESSION_HOUR`, `TACK_BUDGET_SESSION_DAY` | `30`, `80` | Model calls one session may make per hour and per day. |
| `TACK_BUDGET_GLOBAL_HOUR`, `TACK_BUDGET_GLOBAL_DAY` | `600`, `3000` | Model calls the whole preview may make per hour and per day. |
| `TACK_DRAIN_SECONDS` | `25` | Seconds a shutdown waits for active requests to finish. |

## The container

```bash
docker build -t tack-preview .
docker run --rm -p 8080:8080 -e GEMINI_API_KEY=your_key -e TACK_DOWNLOAD_URL=https://example.com/tack.dmg tack-preview
```

The Dockerfile builds the UI in a first stage, then copies `coach/`, `engine/src`, and `ui/dist` into `node:22-slim`. It runs as the `node` user with `node --no-warnings coach/bin/serve.ts`, and its health check calls `GET /healthz`.

To run the same setup without Docker from the repository root:

```bash
cd ui && npm ci && npm run build && cd ..
TACK_HOSTED=1 PORT=8080 node --no-warnings coach/bin/serve.ts
```

## What is kept and what is not

- Each visitor gets a cookie (`tack_sid`, or `__Host-tack_sid` behind HTTPS). It is HttpOnly, SameSite=Lax, carries a server-signed 256-bit random id, stays valid for 24 hours, and renews whenever the visitor returns.
- A session stores its data in a single SQLite file at `<state>/sessions/<hash>.db`. Tack creates it on the first write, closes it after 10 idle minutes, and deletes it after 24 hours without visits. If the session limit is reached, Tack drops the least recently seen idle sessions early, starting with empty ones.
- Shared by everyone: `llm-cache` (model answers keyed by a hash of the model, prompt, schema, and PDF; the prompt includes the résumé text, so a cached parse is only returned for identical text, and no route lists cache contents), `engine-cache` (public job board listings kept for 30 minutes), and `session.key`.
- Kept only in memory and lost on restart: trace events (the last 200 per session), rate limits, and budget counters.
- By default, `/tmp/tack` lives inside the container. Restarting or redeploying clears all sessions, so visitors must start over. To preserve session data across restarts, mount a persistent volume at `TACK_STATE_DIR` that user id 1000 can write to.
- Run exactly one instance. Sessions, trace streams, rate limits, and budgets all live inside that single process.

## Limits

- Request sizes: Up to 1 MB for JSON bodies and 5 MB for a résumé file. Anything larger receives a 413 error with a message.
- Request rates: 240 requests a minute per address, 120 a minute per session, 4 running at once per session, 4 trace streams per session, 16 trace streams per address, and 60 new sessions per address each hour. Exceeding a limit returns a 429 status with `Retry-After` and `{error, code}`.
- Model budget: 30 calls an hour and 80 a day per session, with 600 an hour and 3000 a day for the whole preview. Only calls that miss the cache count toward these limits. If you go over budget, Tack returns 429 with `code: "budget"` and a message the UI displays directly. Screens with built-in fallback data (plan wording, portfolio briefs, interview questions and scoring, role suggestions, and the kit) keep working without the model.
- Disabled features: Requests to `/api/apply*`, `/api/queue*`, `/api/answers*`, `/api/consent`, `/api/practice*`, `/practice/*`, `/api/mail/*`, `/api/applications/sync`, `/api/autopilot*`, and `/api/engine*` return 409 with a message pointing to the desktop app, and start no session. `/api/state` reports `capabilities: {apply: false, mail: false, autopilot: false, reason}`, and the UI shows those parts as running in the desktop app. The autopilot's scheduler never starts in hosted mode.
- Job boards: postings are read live from the public boards. When the boards cannot be reached, the preview falls back to the bundled sample market, labelled as sample.

## Security

- Security headers: Content-Security-Policy (scripts, styles, fonts and connections from the same site only, plus `data:` fonts and images; `frame-ancestors 'none'`), X-Content-Type-Options, Referrer-Policy `no-referrer`, X-Frame-Options, Cross-Origin-Opener-Policy, Permissions-Policy, and HSTS behind HTTPS. Every response includes an `X-Request-Id`.
- Write requests must come from the same origin and send `application/json`. Every write route validates its input.
- Server errors only state that something went wrong and show the request id. They never reveal error messages, file paths, or stack traces.
- Logs output one JSON line per request: timestamp, request id, method, route pattern, status code, duration, and an 8-character session hash. They never record IP addresses, request bodies, user names, or email addresses.
- On `SIGTERM`, Tack stops accepting new requests, closes active trace streams, waits up to 25 seconds for in-flight requests to complete, closes all databases, and exits.

## Why not Vercel

Vercel can run a Dockerfile as a Service with `runtime: "container"`. That setup does not work for Tack:

- Vercel container services run as Vercel Functions. They scale automatically, shut down after 5 idle minutes, and lack sticky routing or a single-instance option. Tack stores sessions, trace streams, rate limits, and budgets inside one process, so running multiple instances would split a visitor's state.
- Every request, including streams, terminates once it reaches the function's maximum run time (300 s by default, 800 s on Pro). Tack's trace stream needs to stay open.
- Vercel rejects request bodies over 4.5 MB. A 5 MB résumé grows to about 6.7 MB once JSON-encoded.
- Daemons let you run a fixed instance count, but they cannot accept HTTP traffic.

Fly.io runs the same Dockerfile as a single long-lived container, which is why `fly.toml` is included instead.

## Fly.io, step by step

1. Install `flyctl` and log in with `fly auth login`.
2. From the repository root, run: `fly launch --no-deploy --copy-config --name your-app-name`. This reuses the existing `fly.toml`. Change `primary_region` in that file if `bom` (Mumbai) is far from your visitors.
3. Configure your secrets: `fly secrets set GEMINI_API_KEY=your_key TACK_SESSION_SECRET=$(openssl rand -hex 32)`.
4. Optional: add `TACK_DOWNLOAD_URL = "https://..."` under `[env]` in `fly.toml`.
5. Deploy a single instance: `fly deploy --ha=false`, then run `fly scale count 1`.
6. Verify the deploy: `curl -I https://your-app-name.fly.dev/` to inspect security headers, and `curl https://your-app-name.fly.dev/healthz` to confirm it returns `{"ok":true}`.
7. Check runtime output: `fly logs`.

The included `fly.toml` keeps one machine running at all times (`auto_stop_machines = "off"`, `min_machines_running = 1`), enforces HTTPS, checks `/healthz` every 30 seconds, sets `TACK_TRUST_PROXY=1` so Tack trusts Fly's proxy, and gives the container 30 seconds to shut down.
