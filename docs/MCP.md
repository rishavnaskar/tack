# Use from an MCP host

`coach/bin/mcp.ts` runs Tack as an MCP server over stdio (JSON-RPC 2.0, protocol version
2025-06-18; hosts on 2025-03-26 or 2024-11-05 get answers in their own version). It needs no
install beyond Node 22.18 or later and talks to the same state as the app, in the same process,
so a task ticked off from a host shows up in the app and the other way round.

Add it to the host's MCP config with absolute paths:

```json
{
  "mcpServers": {
    "tack": {
      "command": "node",
      "args": ["--no-warnings", "/path/to/tack/coach/bin/mcp.ts"],
      "env": { "TACK_STATE_DIR": "/path/to/tack/state" }
    }
  }
}
```

`TACK_STATE_DIR` is optional; it defaults to `state/` at the repo root, the same folder the app
uses. The model key is read from the repo `.env` (`GEMINI_API_KEY` or `TACK_MODEL_KEY`). Without
one, tools still answer with Tack's built-in wording.

Set up the person in the app first (résumé, goal, market, gap map, plan), or load the demo person
there. The server has no tool for intake.

## Tools

All results are short plain text.

| Tool | Arguments | Returns |
|---|---|---|
| `tack_state` | | Person, goal, readiness, plan progress, applications, interviews, mode |
| `tack_gap` | `limit?` (default 5) | Top open skills by priority, each with résumé evidence, posting quotes and any bridge |
| `tack_plan_week` | `week?` (default this week) | The week's tasks with ids, hours and status, and the checkpoint |
| `tack_complete_task` | `taskId`, `status?` (`done`, `todo`, `skipped`; default `done`) | Updated week and overall progress, skills that changed status |
| `tack_next_applications` | `limit?` (default 5) | Unapplied postings ranked by fit and reply rate, with the reason and posting id |
| `tack_prepare_application` | `postingId`, `fresh?` | The application kit: headline, résumé bullets with the résumé line each comes from, cover note, talking points, gaps to address, questions to ask |
| `tack_interview_question` | `sessionId?`, `kind?`, `postingId?` | Starts a five-question mock interview, or returns the next unanswered question of a session |
| `tack_interview_answer` | `sessionId`, `answer`, `questionId?` | Rubric scores with reasons, strengths, fixes, a stronger answer, the follow-up probe and the next question |

## Check it by hand

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"sh","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tack_state","arguments":{}}}' \
  | node --no-warnings coach/bin/mcp.ts
```

`cd coach && node --no-warnings --test test/mcp.test.ts` runs the same exchange against a scratch
state folder with the demo person loaded.
