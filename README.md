# minimi

A chat agent with exactly one tool — web search — built so that **recall and change
detection** are the architecture, not an afterthought.

Every turn is stored as an immutable episode. Every answer with verifiable claims is
stored as a timestamped observation. When you come back later and ask *"is that still
true?"*, the agent can show you what it said, what it saw, and what has moved since.

> **Status: Phase 2 of 5.** The planner is live and its search plan now executes
> for real: up to six Tavily queries fan out in parallel, and the raw results stream into
> a "Web Results" card. Synthesis into an answer (and snapshotting) lands in Phase 3.
> Without a `DEEPSEEK_API_KEY` the server falls back to echo mode; without
> `TAVILY_API_KEY` search returns an explicit stub. See
> [Phase log](DESIGN.md#phase-log) for exactly what is stubbed.

---

## Quickstart

Requires Node 22.12+ (developed on Node 24).

```bash
npm install
cp .env.example .env      # Windows: Copy-Item .env.example .env
npm run dev
```

Open <http://localhost:3000>. **No API keys are needed to boot** — without a
`DEEPSEEK_API_KEY` the server runs in echo mode; without `TAVILY_API_KEY` the search
provider returns a clearly labelled stub instead of calling the network.

With keys, every turn runs the planner, executes its search plan in parallel, and streams
both to the UI:

```
data: {"type":"status","text":"planning…"}
data: {"type":"plan","plan":{"intent":"change", ...}}
data: {"type":"searching","queries":["Supabase pricing","Neon pricing"]}
data: {"type":"search_results","data":[{"query":"...","results":[...]}]}
data: {"type":"done"}
```

Synthesis into a written answer arrives in Phase 3.

## Scripts

| Command             | What it does                                      |
| ------------------- | ------------------------------------------------- |
| `npm run dev`       | `tsx watch` server on `PORT` (default 3000)        |
| `npm start`         | same server, no watch                              |
| `npm test`          | Vitest suite (30 tests, no network)                |
| `npm run typecheck` | `tsc --noEmit`, strict                             |

## Environment

Everything the app reads is declared in [`.env.example`](.env.example):

| Variable                 | Required | Default         | Purpose                                  |
| ------------------------ | -------- | --------------- | ---------------------------------------- |
| `DEEPSEEK_API_KEY`       | no       | —               | Enables the planner; empty = echo mode   |
| `DEEPSEEK_BASE_URL`      | no       | `https://api.deepseek.com` | Swap provider on outage       |
| `DEEPSEEK_MODEL`         | no       | `deepseek-chat` | Model id                                 |
| `LLM_TIMEOUT_MS`         | no       | `60000`         | Per-request timeout                      |
| `TAVILY_API_KEY`         | Phase 2+ | —               | Web search; empty = explicit stub        |
| `PORT`                   | no       | `3000`          | HTTP port                                |
| `DB_PATH`                | no       | `./data/agent.db` | SQLite file (parent dir auto-created)  |
| `STREAM_TOKEN_DELAY_MS`  | no       | `30`            | Echo chunk delay; `0` in tests           |

## How a turn works

```
browser ──POST /chat──▶ express
                          │
                          ├─ open SSE, validate body, read the clock once
                          ├─ memory index: recent episodes + snapshot headers (SQL)
                          ├─ planner (one JSON call) → intent, date ranges, keywords,
                          │                             search plan, verify ids
                          ├─ exact recall + deterministic search fan-out (≤ 6, parallel)
                          ├─ (Phase 3) synthesizer → streamed markdown + fenced JSON
                          └─ emit plan + raw results (now) / persist answer + snapshot (Phase 3)
```

Note the ordering: memory is loaded **before** the planner, so the planner can
reference a snapshot it has actually seen. That is what makes *"is your answer still
correct today?"* answerable without a third model call.

The transport contract is fixed now and will not change:

```text
data: {"type":"status","text":"planning…"}

data: {"type":"plan","plan":{"intent":"change","now_iso":"…", …}}

data: {"type":"searching","queries":["…"]}

data: {"type":"search_results","data":[{"query":"…","results":[{"url":"…"}]}]}

data: {"type":"token","text":"As of "}

data: {"type":"done"}
```

A turn always ends with exactly one `done`, or with one `error`. If the client
disconnects mid-stream, **nothing partial is persisted** — neither the assistant
message nor a snapshot. The user's message is already durable.

## Layout

```
src/
  server.ts        express app + entrypoint (exports createApp for tests)
  config.ts        env parsing + validation
  types.ts         shared types, Zod schemas for claims/sources/planner/SSE
  sse.ts           guarded SSE writer (safe after disconnect)
  time.ts          timezone safety + deterministic range clamps
  llm/
    types.ts       LLMClient seam
    deepseek.ts    OpenAI-compatible client (JSON mode, transport retries)
  planner/
    prompt.ts      system prompt + clock/timezone/memory injection
    index.ts       parse → validate (Zod) → sanitize, one bounded retry
  search/
    types.ts       SearchProvider seam + result/group shapes
    tavily.ts      REST client, mode mapping, offline stub
    exa.ts         second provider stub
    fanout.ts      parallel execution, 6-query cap, per-query failure isolation
  memory/
    index.ts       deterministic memory index built before planning
  db/
    schema.sql     tables, indexes, FTS5 mirror + triggers
    index.ts       createDb(), migrations, typed queries
  routes/chat.ts   POST /chat
public/
  index.html       markup only
  styles.css
  js/
    main.js        entry: wires the form, runs one turn
    api.js         POST /chat transport + typed errors
    sse.js         SSE frame parser (pure, unit-tested)
    ui.js          ChatView, bubbles, plan card (DOM only)
    session.js     session id persistence
tests/             85 tests, all offline
data/              SQLite lives here (gitignored)
```

No bundler, no build step: the browser loads these as native ES modules.

## Testing

```bash
npm test        # offline: in-memory SQLite, no API keys, no network
```

The suite covers migration idempotency, schema shape, time-range boundaries, keyword
recall, snapshot round-trips, foreign-key enforcement, SSE framing (including byte-split
frames and multi-byte characters), disconnect safety, exact echo reconstruction,
memory-index construction, planner parsing/sanitisation, the single schema retry,
planner-mode streaming, Tavily request mapping, fan-out caps, and per-query failure
isolation. The LLM and the network are faked, so `npm test` never leaves the machine.

## Design

Read [DESIGN.md](DESIGN.md). The short version: **AI for judgment, code for state.** Two
model calls per turn (one so far), everything else deterministic.
