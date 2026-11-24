import { Router } from 'express';
import type { Db } from '../db';
import { buildMemoryIndex } from '../memory';
import { degradedPlan, PlannerError, type Planner } from '../planner';
import { executeSearchPlan } from '../search/fanout';
import type { SearchProvider } from '../search/types';
import { openSse, type SseStream } from '../sse';
import { safeTimezone } from '../time';
import { ChatRequestSchema, type PlannerOutput } from '../types';

export interface ChatRouterDeps {
  db: Db;
  /** Delay between streamed chunks in echo mode. 0 in tests. */
  chunkDelayMs: number;
  /** Null/absent means "no model configured": echo mode. */
  planner?: Planner | null;
  /** Null/absent means "no search configured": plan-only turns. */
  searchProvider?: SearchProvider | null;
  /** Injectable clock, for deterministic tests. */
  now?: () => Date;
}

/**
 * Split text into chunks of ~N whitespace-separated words without changing a
 * single character, so `chunks.join('')` is always the original answer.
 */
export function chunkReply(text: string, wordsPerChunk = 4): string[] {
  if (text.length === 0) return [];

  const pieces = text.match(/\S+\s*/g);
  if (!pieces) return [text];

  const leading = text.slice(0, text.length - pieces.join('').length);
  const chunks: string[] = [];

  for (let i = 0; i < pieces.length; i += wordsPerChunk) {
    chunks.push(pieces.slice(i, i + wordsPerChunk).join(''));
  }

  const first = chunks[0];
  if (leading.length > 0 && first !== undefined) {
    chunks[0] = leading + first;
  }

  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Phase 0 echo path, kept as the no-keys fallback. It also proves the final
 * loop shape: stream tokens, then write state, then close.
 */
async function echoTurn(
  db: Db,
  stream: SseStream,
  input: { sessionId: string; message: string },
  chunkDelayMs: number,
  at: Date,
): Promise<void> {
  stream.send({ type: 'status', text: 'thinking…' });

  const reply = `echo: ${input.message}`;

  for (const chunk of chunkReply(reply)) {
    if (stream.closed) return;
    stream.send({ type: 'token', text: chunk });
    if (chunkDelayMs > 0) await sleep(chunkDelayMs);
  }

  if (stream.closed) return;

  db.insertMessage({
    sessionId: input.sessionId,
    role: 'assistant',
    content: reply,
    createdAt: at.toISOString(),
  });

  stream.send({ type: 'done' });
  stream.end();
}

/**
 * Phase 1 planner-only path.
 *
 * No assistant message is persisted yet: there is no synthesized answer to
 * remember, and inventing one would poison later recall. Phase 3 replaces the
 * tail of this function with the synthesizer.
 */
async function planTurn(
  stream: SseStream,
  planner: Planner,
  searchProvider: SearchProvider | null,
  input: {
    message: string;
    userTz: string;
    memoryIndex: ReturnType<typeof buildMemoryIndex>;
  },
  now: Date,
): Promise<void> {
  stream.send({ type: 'status', text: 'planning…' });

  let plan: PlannerOutput;
  let degraded = false;

  try {
    const result = await planner.plan(input.message, {
      now,
      userTz: input.userTz,
      memoryIndex: input.memoryIndex,
      signal: stream.signal,
    });
    plan = result.plan;
  } catch (error) {
    if (stream.closed) return;
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      '[chat] planner degraded:',
      detail,
      error instanceof PlannerError ? error.issues : '',
    );
    plan = degradedPlan(now);
    degraded = true;
  }

  if (stream.closed) return;

  if (degraded) {
    stream.send({
      type: 'status',
      text: 'planner unavailable — degraded to chat; no search this turn',
    });
  }

  stream.send({ type: 'plan', plan });

  const queries = plan.search_plan;
  const willSearch = searchProvider !== null && queries.length > 0;

  if (willSearch && searchProvider) {
    stream.send({
      type: 'searching',
      queries: queries.map((entry) => entry.query),
    });

    try {
      const grouped = await executeSearchPlan(queries, searchProvider);
      if (stream.closed) return;
      stream.send({ type: 'search_results', data: grouped });
    } catch (error) {
      // executeSearchPlan is total by design; this is belt-and-braces so a
      // search bug can never turn a planned turn into a 500.
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[chat] search fan-out failed:', detail);
    }
  }

  if (stream.closed) return;

  const note = willSearch
    ? `search complete (${queries.length} ${queries.length === 1 ? 'query' : 'queries'})`
    : searchProvider === null
      ? 'search disabled'
      : 'no search needed';

  stream.send({
    type: 'status',
    text: `${note} — synthesis arrives in phase 3`,
  });
  stream.send({ type: 'done' });
  stream.end();
}

export function createChatRouter(deps: ChatRouterDeps): Router {
  const router = Router();
  const planner = deps.planner ?? null;
  const searchProvider = deps.searchProvider ?? null;
  const now = deps.now ?? (() => new Date());

  router.post('/chat', async (req, res) => {
    const parsed = ChatRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: 'invalid_request',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    const { sessionId, message } = parsed.data;
    const userTz = safeTimezone(parsed.data.userTz);
    const stream = openSse(res);
    const at = now();

    // Memory means "before this turn". Build the index before inserting the
    // user message so the planner is not shown its own question twice.
    const memoryIndex = planner ? buildMemoryIndex(deps.db, at) : [];

    try {
      deps.db.upsertSession(sessionId, userTz, at.toISOString());
      deps.db.insertMessage({
        sessionId,
        role: 'user',
        content: message,
        createdAt: at.toISOString(),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[chat] failed to record user turn:', detail);
      stream.send({ type: 'error', message: 'Could not record this turn.' });
      stream.end();
      return;
    }

    try {
      if (!planner) {
        await echoTurn(
          deps.db,
          stream,
          { sessionId, message },
          deps.chunkDelayMs,
          at,
        );
        return;
      }

      await planTurn(
        stream,
        planner,
        searchProvider,
        { message, userTz, memoryIndex },
        at,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[chat] turn failed:', detail);
      stream.send({ type: 'error', message: 'Something went wrong on the server.' });
      stream.end();
    }
  });

  return router;
}
