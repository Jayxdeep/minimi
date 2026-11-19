# minimi

A chat agent with exactly one tool — web search — built so that **recall and change
detection** are the architecture, not an afterthought.

Every turn is stored as an immutable episode. Every answer with verifiable claims is
stored as a timestamped observation. When you come back later and ask *"is that still
true?"*, the agent can show you what it said, what it saw, and what has moved since.

> **Status: Phase 0 of 5.** Transport, persistence and streaming are real; the model
> calls are not wired up yet, so `/chat` currently streams `echo: <your message>`.
> See [Phase log](DESIGN.md#phase-log) for exactly what is stubbed.

---

## Quickstart

Requires Node 22.12+ (developed on Node 24).

```bash
npm install
cp .env.example .env      # Windows: Copy-Item .env.example .env
npm run dev
```

Open <http://localhost:3000>. **No API keys are needed for Phase 0** — the server boots
in echo mode and tells you so on startup.

To try the real thing once Phases 1–3 land, fill in `DEEPSEEK_API_KEY` and
`TAVILY_API_KEY` in `.env`.

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
| `DEEPSEEK_API_KEY`       | Phase 1+ | —               | Planner + synthesizer                    |
| `TAVILY_API_KEY`         | Phase 2+ | —               | Web search                               |
| `PORT`                   | no       | `3000`          | HTTP port                                |
| `DB_PATH`                | no       | `./data/agent.db` | SQLite file (parent dir auto-created)  |
| `STREAM_TOKEN_DELAY_MS`  | no       | `30`            | Echo chunk delay; `0` in tests           |

## How a turn works

```
browser ──POST /chat──▶ express
                          │
                          ├─ open SSE, validate body
                          ├─ upsert session, append user episode
                          ├─ (Phase 1) planner  → intent, date ranges, search plan
                          ├─ (Phase 2) SQL recall → episodes + snapshots + FTS hits
                          ├─ (Phase 2) search fan-out (deterministic)
                          ├─ (Phase 3) synthesizer → streamed markdown + fenced JSON
                          └─ persist assistant episode + snapshot, emit done
```

The transport contract is fixed now and will not change:

```text
data: {"type":"status","text":"thinking…"}

data: {"type":"token","text":"echo: On Monday we "}

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
  db/
    schema.sql     tables, indexes, FTS5 mirror + triggers
    index.ts       createDb(), migrations, typed queries
  routes/chat.ts   POST /chat
public/index.html  vanilla chat UI (no build step)
tests/             30 tests, all offline
data/              SQLite lives here (gitignored)
```

## Testing

```bash
npm test        # offline: in-memory SQLite, no API keys, no network
```

The suite covers migration idempotency, schema shape, time-range boundaries, keyword
recall, snapshot round-trips, foreign-key enforcement, SSE framing, disconnect safety,
and exact echo reconstruction.

## Design

Read [DESIGN.md](DESIGN.md). The short version: **AI for judgment, code for state.** Two
model calls per turn, everything else deterministic.
