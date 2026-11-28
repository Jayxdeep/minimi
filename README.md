# minimi

A chat agent with exactly one tool — web search — built so that **recall and change
detection** are the architecture, not an afterthought.

Every turn is stored as an immutable episode. Every answer with verifiable claims is
stored as a timestamped observation. When you come back later and ask *"is that still
true?"*, the agent can show you what it said, what it saw, and what has moved since.

> **Status: Phase 4 of 5.** Recall, change detection and the eval harness are in place:
> the planner's window, keyword hits, re-verify ids and linked snapshots are loaded
> deterministically and given to the synthesizer with full claim values and sources.
> Change answers use **Changed / Unchanged / Couldn't verify**, and an empty memory
> produces "no record", not a guess. Phase 5 is eval polish and docs. Without a
> `DEEPSEEK_API_KEY` the server falls back to echo mode; without `TAVILY_API_KEY` search
> returns an explicit stub. See [Phase log](DESIGN.md#phase-log).

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

With keys, every turn runs the planner, executes its search plan in parallel, streams the
answer, and stores the episode plus a snapshot:

```
data: {"type":"status","text":"planning…"}
data: {"type":"plan","plan":{"intent":"change", ...}}
data: {"type":"searching","queries":["Supabase pricing","Neon pricing"]}
data: {"type":"search_results","data":[{"query":"...","results":[...]}]}
data: {"type":"status","text":"writing the answer…"}
data: {"type":"token","text":"Supabase Pro is "}
data: {"type":"done"}
```

The fenced JSON trailer the model uses for claims/sources is stripped before it reaches the
browser. If it is invalid, the turn ends with `error` and **nothing is persisted** — not even
the streamed answer.

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
                          ├─ synthesizer → streamed markdown + fenced JSON trailer
                          └─ persist episode + snapshot in one transaction, emit done
```

Note the ordering: memory is loaded **before** the planner, so the planner can
reference a snapshot it has actually seen. That is what makes *"is your answer still
correct today?"* answerable without a third model call.

Recall then merges four deterministic sources: the resolved window, FTS keyword hits,
explicit re-verify ids, and snapshots linked to recalled episodes. The synthesizer gets
full claim values and source URLs, not just headers.

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
  synth/
    prompt.ts      answer prompt + numbered sources + verdict + trailer contract
    fence.ts       streaming splitter (answer now, JSON trailer withheld)
    sources.ts     citation indexes → real URLs, evidence remapping
    index.ts       stream, parse trailer, build claims/sources
  recall/
    index.ts       window + keyword + re-verify + linked-snapshot recall
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
    ui.js          ChatView, bubbles, plan/results cards (DOM only)
    markdown.js    small safe renderer (parsers unit-tested)
    url.js         http(s)-only URL helpers
    session.js     session id persistence
tests/             144 tests, all offline
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
memory-index construction, planner parsing/sanitisation, the single schema retry, Tavily
request mapping, fan-out caps, failure isolation, URL dedupe, fence splitting, trailer
parsing, citation remapping, atomic episode + snapshot writes including rollback,
deterministic recall (window, keywords, re-verify, episode links, capping), and the eval
harness: the three canonical queries run end-to-end against seeded snapshots, plus the
pasted-text and missing-memory cases. The LLM and the network are faked, so `npm test`
never leaves the machine.

## Design

Read [DESIGN.md](DESIGN.md). The short version: **AI for judgment, code for state.** Two
model calls per turn (one so far), everything else deterministic.
