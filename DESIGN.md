# DESIGN

A chat agent with one tool, built for the three questions that break ordinary assistants:

1. *"On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them
   changed pricing or shipped something big since?"*
2. *"What did I ask you on 3 November? Is your answer still correct today?"*
3. *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"*

None of these is a lookup. Each one has a **temporal reference** (`Monday`,
`3 November`, `last Tuesday`), a **memory dependency** (what was said then), and a
**change question** (what is true now). The architecture is organised around that seam.

---

## 1. The governing principle

> **AI for judgment, code for state.**

Every model call adds latency, cost and non-determinism. So the model is used only where
the input is genuinely ambiguous or the output requires synthesis:

| Decision                         | Owner       | Why                                            |
| -------------------------------- | ----------- | ---------------------------------------------- |
| Intent + resolving "last Tuesday" | Planner LLM | Language, not arithmetic                       |
| Which episodes/snapshots to load  | Code        | Exact, indexable, replayable                   |
| Search fan-out                    | Code        | Deterministic, bounded, cacheable              |
| Change detection                  | Synthesizer | Needs judgment over old claim vs new source    |
| Snapshot + episode persistence    | Code        | State must be durable and inspectable          |

The code layer is not glue between prompts. It is the memory of the system.

## 2. Exactly two model calls per turn

```
        ┌──────────────────────────── code ────────────────────────────┐
t=0     │ memory index read: last N days of episodes + snapshot headers │
t≈400ms │ PLANNER(message, now_utc, now_local, tz, memory_index)        │  ← call 1
        │   → intent, temporal_refs, memory{window,keywords},           │
        │     search_plan, verify_snapshot_ids                          │
t≈500ms │ exact recall: time window ∪ FTS keyword hits ∪ verify ids     │
t≈600ms │ fan-out: plan queries + verification queries (from snapshots) │
t≈3s    │ SYNTHESIZER(memory + sources) → markdown + fenced JSON        │  ← call 2
t=end   │ persist assistant episode + snapshot, emit done               │
        └──────────────────────────────────────────────────────────────┘
```

**Why the memory index comes before the planner.** The obvious order — plan, then recall —
cannot answer queries 1–3. The planner would have to write search queries for *an answer it
has not seen yet*. Loading a compact index first (dates, labels, entity sets, claim
subjects) lets the planner emit `verify_snapshot_ids` and keywords while the invariant
still holds: this is one indexed SQL read, not a third model call.

**One documented exception.** If the planner's JSON fails Zod validation, it is retried
once with the validation error fed back. That is a retry, not a call: worst case two
planner attempts, still one synthesizer. The synthesizer is never retried mid-stream,
because half an answer cannot be un-said.

**Status.** Both calls and the recall layer are implemented: the planner chooses what to
look for, `recallMemory` loads exactly that (plus linked snapshots) from SQL, and the
synthesizer compares stored claims with current sources. A completed turn persists the
assistant episode and, when the answer made verifiable claims, its snapshot.

## 3. Episodes and observations are different things

Two tables carry all memory, and they answer different questions.

```sql
-- Episodes: every turn, verbatim, never rewritten.
messages(id, session_id, role, content, created_at)

-- Observations: what we saw and what we claimed, with the moment we saw it.
snapshots(
  id, message_id,
  label,            -- "CRM shortlist (5 tools)"
  topic_key,        -- derived from sorted entities; stable across label drift
  entities_json,    -- ["ToolA","ToolB",...]
  claims_json,      -- [{subject, attribute, value, as_of, source_ids, confidence}]
  sources_json,     -- [{url, title, published_date, retrieved_at, snippet, content_hash}]
  observed_at,      -- when WE looked
  supersedes_id     -- previous observation of the same topic
)
```

Three consequences worth defending:

- **`observed_at`, not `valid_from`.** We cannot know when a vendor changed a price. We
  can know when we looked. Conflating those is how "still correct?" turns into a lie.
- **Claims are structured, not prose.** `attribute` (`pricing`, `plan_tier`, `release`) is
  the axis that changes, which is exactly what a future diff needs. Prose would force
  another model call to compare.
- **`topic_key` comes from the sorted entity set, not the label.** The model writes the
  label differently every time ("CRM shortlist (5 tools)" / "the CRM tools we discussed");
  the entity set is stable, so the chain of observations is findable in one indexed query.
  `supersedes_id` links an observation to the one it re-checks.

**Atomicity.** `insertSnapshot` is deliberately not wrapped on its own: it is one `INSERT`
(SQLite autocommit, atomic and durable on return) followed by a synchronous read-back, with
no `await` between them, so no other turn in the process can interleave. The first genuinely
multi-statement write is the assistant episode plus its snapshot, which must agree; that pair
runs inside `raw.transaction(fn).immediate()` (`persistAnswer`), so a turn persists both or
neither. Invalid evidence rolls the episode back with it. A transaction never spans an
`await`.

**Recall.** The synthesizer does not get "recent stuff". After the planner runs,
`recallMemory` merges four deterministic sources: the resolved `memory.window`, FTS keyword
hits for episodes plus LIKE hits for snapshot labels/entities, the planner's
`verify_snapshot_ids`, and snapshots linked to any recalled episode. The current turn is
excluded by message id, explicit re-verify snapshots survive capping, and the result is
rendered with claim **values**, `as_of` dates, and source URLs. This is why query 1 works
even though "on Monday" resolves to a window that does not contain the Thursday shortlist:
keyword recall bridges the gap, and the model then compares real stored claims.

### Keyword recall, not embeddings

Time windows alone cannot find "the shortlist we made on Monday" if the memory window is
wrong, and vector search cannot honour *"3 November"* — it returns semantic neighbours, not
temporal truth. So recall is deterministic SQL:

- exact UTC range scan over `messages.created_at` and `snapshots.observed_at`;
- SQLite **FTS5** over message contents, seeded with `memory.keywords` from the planner,
  ranked by `bm25`;
- both merged, de-duplicated, capped.

No embedding index, no vector database, no approximate recall. The planner supplies the
ambiguous part (keywords, dates); the database does the retrieval exactly.

### Time discipline

All timestamps are written by code as `new Date().toISOString()` — UTC, ISO-8601, `Z`.
That makes lexicographic comparison equal chronological comparison, so `BETWEEN ? AND ?`
is a correct time query in SQLite without date functions. Bare dates (`2025-11-03`) are
expanded to the full UTC day. Date references are resolved in the user's timezone
(`sessions.user_tz`, sent by the browser), then converted to UTC instants before querying.

## 4. What "still correct?" can and cannot mean

This is the part the product lives or dies on.

A snapshot is evidence, not truth. When the agent re-checks a topic it produces one of
three verdicts per claim, and it says which one:

| Verdict              | Evidence                                                     | Wording                                   |
| -------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| **Changed**          | new source contradicts the stored claim, or a newer source is dated after `observed_at` with a different value | "As of <date>, X was $Y. It is now $Z." |
| **Unchanged**        | no newer source contradicts the stored observation, and the stored observation is known | "No change observed since <date>. Last observed X at $Y." |
| **Couldn't verify**  | memory is missing, or sources are absent, undated, paywalled, or contradictory | "I can't verify this: I have no stored claim / no dated source I can trust." |

The rule is simple and non-negotiable: **absence of evidence of change is not evidence of
no change**. `Unchanged` is the label for "no contradicting evidence, with a known
observation window" — it is never an absolute claim, and the answer always states its
observation window. A judge who asks "how do you know nothing changed?" should get that
sentence, not a confident guess.

Sources carry `published_date` (nullable, often absent), `retrieved_at`, the `snippet` we
actually read, and a normalised `content_hash`. The hash is what makes a future
"the page changed" check cheap and honest — we can compare what we saw then with what we
see now without pretending a crawl date is a publication date.

## 5. Planner contract

The planner is one JSON-mode call. Dates are injected, never guessed from a system clock
inside the model:

```jsonc
{
  "intent": "recall" | "lookup" | "change" | "chat",
  "now_iso": "2026-11-19T10:00:00.000Z",
  "temporal_refs": [
    { "expression": "last Tuesday", "resolved_range": ["2025-11-11T00:00:00.000Z", "2025-11-11T23:59:59.999Z"] }
  ],
  "memory": {
    "window": ["2025-11-11T00:00:00.000Z", "2025-11-13T23:59:59.999Z"] | null,
    "keywords": ["postgres", "hosting", "pricing"]
  },
  "search_plan": [
    { "query": "Supabase pricing", "mode": "quick", "since": "2025-11-11" }
  ],
  "verify_snapshot_ids": ["snap_01..."]
}
```

- `intent` is the **dominant** operation. "What did I ask on 3 November, and is it still
  correct?" is `recall`: the retrieval comes first, but `verify_snapshot_ids` is populated
  independently, so the verification half is not lost in a single enum.
- Bare month/day references resolve to the most recent past occurrence, with the assumption
  stated in the answer rather than asked as a clarifying question.
- Code validates the output with Zod, clamps ranges to a sane window
  (`now − 5 years … now + 1 day`), and executes the plan verbatim. **The AI proposes; code
  disposes.**

What "disposes" means concretely, all deterministic and all tested:

| Model output                        | Code behaviour                                              |
| ----------------------------------- | ----------------------------------------------------------- |
| `now_iso`                           | overwritten with the server clock; never trusted            |
| implausible / inverted date range   | dropped; an invalid `memory.window` becomes `null`          |
| `verify_snapshot_ids`               | filtered to ids the planner was actually shown              |
| > 6 search queries, duplicates      | truncated to 6, case-insensitively deduped, whitespace collapsed |
| empty query                         | dropped                                                     |
| `since` not `YYYY-MM-DD`            | removed, query kept                                         |
| > 8 keywords                        | truncated and lowercased                                    |

The planner runs at `temperature: 0` with `max_tokens: 1200` in JSON mode. Transport
failures are not retried by the planner (the SDK owns one transport retry); only schema
failures get the single correction attempt, because that is the failure mode this provider
actually exhibits.

### Walkthrough: query 2

1. Planner: `intent=recall`, range = 3 Nov in the user's timezone, keywords `["..."]`.
2. Code: episodes in that range; `snapshots.observed_at` in that range; FTS fallback if the
   window is empty.
3. **If nothing was recorded, the answer says so.** It does not invent a conversation.
4. If an episode exists: quote the user's message verbatim, and the stored claims with their
   `observed_at`.
5. `verify_snapshot_ids` drives re-search; the synthesizer compares stored claim vs new
   source and returns the verdict table above.
6. Persist a new snapshot with the same `topic_key` and `supersedes_id = old.id`.

## 6. Synthesizer contract

One streaming call. Markdown streams to the user immediately; a single fenced JSON block at
the end carries structured claims and **citation indexes**, never URLs:

````text
As of 11 Nov I told you Supabase's Pro plan was $25/mo [1]. Since then...

```json
{
  "label": "Postgres hosting pricing",
  "entities": ["Supabase", "Neon"],
  "claims": [
    { "subject": "Supabase", "attribute": "pricing", "value": "Pro $25/mo",
      "as_of": "2025-11-11", "source_ids": [1], "confidence": 0.8 }
  ],
  "used_sources": [1],
  "supersedes_id": "snap_01..."
}
````

Why indexes instead of URLs: a model can hallucinate a URL, but it cannot hallucinate a
search result that exists. Code flattens the grouped results into a numbered `SOURCES` block
in exactly the order the UI renders them, so `[3]` on screen is source 3 in the trailer.
Indexes are mapped back to real `{url, title, snippet, published_date}` rows. Unknown indexes
drop the claim; a claim with no surviving source is not stored at all. That is citation
validation by construction, not a post-hoc string match.

Implementation details that matter:

- The streamer holds back only the longest possible fence prefix, so no ```` ``` ```` leaks
  into the answer; the JSON block is parsed on completion, never incrementally.
- A ```` ```sql ```` block in the answer streams normally. Only a line-start
  ```` ```json ```` is treated as the trailer.
- The trailer is parsed as the last JSON block, tolerating a missing closing fence and
  trailing prose.
- Stored claim `source_ids` are **0-based positions in the snapshot's own `sources` array**,
  not prompt indexes. The source list is compacted to the ones actually used, and both are
  remapped together.
- Duplicate URLs are removed across queries before streaming and synthesis, so a page that
  appears under four queries gets one citation index and one stored row.
- No trailer, invalid JSON, or an empty answer → `error` event, and nothing is persisted —
  not even the assistant episode. An answer with no citable claims (chat, or an honest
  "I can't verify") persists the episode, with no snapshot.

The answer uses exactly those three verdict labels when the question is temporal. Two more
prompt rules came from live failures:

- Read every snippet, especially markdown tables and version numbers; if a source contains
  the exact answer, extract it verbatim even if it falls outside the requested time window.
- When the user pastes a large block of text and asks about it, answer from that text and do
  not search or recall. The synthesizer prompt puts this override first; code also clamps the
  plan (`>= 500` characters → `chat`, no window or keywords, empty `search_plan`/verify ids)
  and passes an empty recall, so a model that ignores the instruction still cannot see memory.
- The last four messages of the **current session** are injected as
  `### RECENT CONVERSATION HISTORY` (oldest first, current turn excluded). This is separate
  from global recall: it is what makes "summarize this" refer to the answer the agent just
  gave, while recall answers "what did we discuss on 3 November".

## 7. Search

One provider interface, one implementation in week 1:

```ts
interface SearchProvider {
  search(query: string, opts: { mode: 'quick' | 'deep' | 'news'; since?: string }): Promise<SearchResult[]>;
}
```

Tavily is primary because it returns a snippet and an optional publish date in one call;
Exa is stubbed behind the same interface. Concrete choices:

| Our mode | Tavily `topic` | `search_depth` | `max_results` |
| -------- | -------------- | -------------- | ------------- |
| `quick`  | general        | basic          | 5             |
| `news`   | news           | basic          | 5             |
| `deep`   | general        | advanced       | 8             |

- Auth is `Authorization: Bearer …`, not a key in the JSON body, so the key never lands in
  a request log or an error dump.
- `since` maps to `start_date` only when it matches `YYYY-MM-DD`; anything else is dropped.
- `include_published_date: true` is always requested. Without it, general (non-news)
  searches omit `published_date`, and change detection loses its only usable timestamp.
- Fan-out is capped at **6 queries in code**, independently of the planner, executed with
  `Promise.allSettled` and an 8-second timeout per request. One failed query becomes an
  empty group and is logged; it never fails the turn. This is the one place where partial
  success is better than total failure.
- No API key returns a single clearly-labelled stub result (`Tavily key missing`) rather
  than silently pretending there are no results. Tests and key-less demos exercise the same
  code path.
- Results are passed through as `{url, title, snippet, publishedDate?}`. This is also what
  Phase 3 will cite and what a snapshot will store.

Honest limitation: date filters (`start_date`, `days`, `time_range`) are reliable on news
topic searches, not on arbitrary vendor pages, and most pricing pages carry no crawl date at
all. So **time filtering is a hint, not the mechanism**. Recency is judged from
`publishedDate` plus content, and recorded as `observed_at`. The design does not pretend a
search API can tell us when a price changed.

## 8. Streaming contract

SSE over `POST`, read with `fetch` + `ReadableStream` (no `EventSource`, because it cannot
POST). Frames are newline-delimited JSON:

```text
data: {"type":"status","text":"planning…"}
data: {"type":"plan","plan":{...}}          // dev-visible planner output
data: {"type":"searching","queries":["…"]}  // fan-out started
data: {"type":"search_results","data":[…]}  // grouped by query, raw
data: {"type":"token","text":"As of "}
data: {"type":"error","message":"..."}      // terminal
data: {"type":"done"}                       // terminal
```

Exactly one terminal frame per turn. The response sets `X-Accel-Buffering: no`, flushes
headers immediately, disables Nagle, and all writes go through a guard that drops frames
after close. On `close`: stop generating, do not persist the assistant message, do not write
a snapshot. Partial state is worse than no state.

The browser side is plain ES modules served directly (`public/js/`): `api.js` owns the POST,
`sse.js` owns framing, `ui.js` owns the DOM, `main.js` owns the turn. The frame parser is a
pure `createSseParser(onEvent)` and is unit-tested in Node, including frames split mid-JSON
and mid-UTF-8. Handler exceptions are deliberately outside the JSON `try/catch`, so a
terminal `{type:"error"}` actually stops the stream instead of being swallowed by the
parser.

Answers stream as plain text for speed, then `ui.js` re-renders the accumulated markdown on
`done`. The renderer (`markdown.js`) never touches `innerHTML`: it builds nodes from a small
pure parser and restricts links to `http(s)`, so a hostile source cannot inject markup or a
`javascript:` URL. Its tokenizer and block parser are unit-tested in Node.

## 9. Failure ladder

| Failure                        | Behaviour                                                        |
| ------------------------------ | ---------------------------------------------------------------- |
| Planner invalid twice          | degrade to `intent=chat`, no search, visible `status` note        |
| Planner timeout                | same as above                                                     |
| Search timeout / zero results  | answer from memory only; sources marked unavailable; no snapshot  |
| Synthesizer breaks mid-stream  | `error` frame; no assistant row, no snapshot                      |
| Client disconnects             | stop; user episode kept, assistant + snapshot discarded           |
| DB unavailable                 | `/health` reports `db: down`; `/chat` 500 before SSE starts       |

The system never silently degrades into a confident answer built on nothing.

## 10. Rejected approaches

| Rejected                              | Why                                                              |
| ------------------------------------- | ---------------------------------------------------------------- |
| Pure ReAct loop                       | Multi-hop is slow and unstructured change detection is unreliable |
| Vector RAG for memory                 | Cannot resolve "3 November"; returns semantic neighbours, not temporal truth |
| Scrape-everything                     | Slow, brittle, unnecessary for the test set                      |
| Multi-tool sprawl                     | One tool, three modes. More tools ≠ better                       |
| Multi-provider search in week 1       | Tavily only; Exa behind the interface, unimplemented             |
| Incremental JSON parser while streaming | Fenced trailing JSON is the 80/20                             |
| Three-tier intent classifier          | One JSON-mode planner is enough for four intents                 |
| LangChain / agent frameworks          | They hide the loop that this project is about                    |

## 11. Testing and evals

Two tiers, deliberately separated:

1. **`npm test` — deterministic, offline.** In-memory SQLite; `FakeLLMClient` and
   `FakeSearchProvider` replay recorded fixtures. The three canonical queries become
   end-to-end tests: given this message, this clock and these fixtures, assert the recall
   window, the emitted SSE sequence, and the snapshot rows written. These tests *are* the
   architecture; if they cannot be written, the pipeline is wrong.
2. **`npm run eval` — live, opt-in.** Hits real DeepSeek/Tavily, stores full transcripts
   under `evals/runs/`. Deliberately excluded from `npm test` so CI never depends on the
   network or a model's mood.

Date resolution is the main source of non-determinism, so it is tested separately with a
frozen clock and explicit timezone cases (including a DST boundary and a bare
"3 November" in January).

Current suite (Phase 4): 149 tests. Beyond the earlier coverage, recall is tested across
all four sources (window, FTS keywords, explicit re-verify ids, episode-linked snapshots),
including exclusion of the current turn and priority-preserving caps. The eval harness
(`tests/eval.test.ts`) seeds the Nov 19 CRM shortlist and the Nov 3 Postgres comparison,
runs all three canonical queries against scripted model output, and asserts: the synthesizer
prompt contains the old claim values, answers carry the three verdict labels, the new
snapshot supersedes the seeded one, pasted text produces no search, and an empty memory
yields "no record" with no stored evidence. The LLM and the search provider are fakes;
`npm test` never touches the network.

## 12. Security and limits

- Request body is Zod-validated: `sessionId` ≤ 200 chars, message ≤ 8 000 chars.
- Model output is rendered with `textContent`, never `innerHTML` — no XSS via streamed
  markdown.
- Search results and claims are untrusted input; citations are checked against the result
  set before they reach a snapshot.
- Single global user is intentional (see §13). There is no auth, so the server is meant to
  run locally.

## 13. Known limitations (stated, not hidden)

- **No fact graph yet.** Snapshots are per-answer observations. Cross-answer entity
  reconciliation is week 2; `claims.attribute` and `topic_key` are the seams for it.
- **Single user, no auth.** Memory is global across sessions because the judge tests
  cross-session recall.
- **No embeddings.** Keyword recall misses paraphrase when the planner supplies poor
  keywords. This is a real trade: exactness and explainability over fuzzy matching.
- **Search coverage is the ceiling.** If Tavily does not surface a changed pricing page,
  the honest answer is "no evidence", not "unchanged".
- **One model, two prompts.** `deepseek-chat` only; `deepseek-reasoner` cannot do JSON mode
  or tool calls, and two prompts are easier to reason about than a router.

## Phase log

| Phase | Shipped                                                                | Stubbed / next                          |
| ----- | ---------------------------------------------------------------------- | --------------------------------------- |
| 0.1   | Repo scaffold, strict TS, scripts, `.env.example`, offline test harness | —                                       |
| 0.2   | SQLite schema, migrations, UTC-ISO timestamps, FTS5 recall, snapshot chaining, typed helpers | —                        |
| 0.3   | Express app, `POST /chat` SSE envelope, `/health`, vanilla chat UI       | Handler sends only `done`               |
| 0.4   | Echo streaming, session upsert, episode persistence, disconnect safety  | Model calls absent                      |
| 0.5   | README, this document, phase log                                        | —                                       |
| 1     | Planner + `LLMClient`/`DeepSeekClient`, memory index before planning, Zod validation + one retry, deterministic sanitisation, plan SSE frame | Search; synthesis |
| 2     | Tavily provider (mode/`since` mapping, offline stub), parallel fan-out (≤ 6, failure-isolated), `searching`/`search_results` SSE, Web Results card | Synthesis; recall merge moves to Phase 4 |
| 3     | Synthesizer streaming, fence splitter, index-based citations, duplicate-URL collapse, snapshot + episode in one `raw.transaction(fn).immediate()` | Cross-turn recall/verification wiring |
| 4     | Deterministic recall (window + keywords + re-verify + episode links), full claims into the synthesizer, Changed/Unchanged/Couldn't verify verdicts, pasted-text clamp, `tests/eval.test.ts` for the canonical queries + missing memory | Live eval runner, design polish |
| 5     | Offline fixture evals, live eval runner, design polish                  | —                                       |
