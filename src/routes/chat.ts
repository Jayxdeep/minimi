import { Router } from 'express';
import type { Db } from '../db';
import { buildMemoryIndex } from '../memory';
import { degradedPlan, PlannerError, type Planner } from '../planner';
import { recallMemory, recallSnapshotIds } from '../recall';
import { executeSearchPlan, dedupeSearchGroups } from '../search/fanout';
import type { SearchGroup, SearchProvider } from '../search/types';
import { openSse, type SseStream } from '../sse';
import type { SynthesisResult, Synthesizer } from '../synth';
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
  /** Null/absent means "no answer layer": plan + raw results only. */
  synthesizer?: Synthesizer | null;
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
 * Plan → search → synthesize.
 *
 * The planner is call 1 and the synthesizer is call 2; everything between them
 * is deterministic code. A turn is stored only after the trailer validates, and
 * the assistant episode plus its snapshot commit in one IMMEDIATE transaction.
 */
async function planTurn(
  db: Db,
  stream: SseStream,
  planner: Planner,
  searchProvider: SearchProvider | null,
  synthesizer: Synthesizer | null,
  input: {
    sessionId: string;
    message: string;
    userTz: string;
    userMessageId: string;
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

  // Deterministic recall: the planner chose what to look for; this loads it.
  const recall = recallMemory(db, plan, {
    excludeMessageId: input.userMessageId,
  });

  const queries = plan.search_plan;
  const willSearch = searchProvider !== null && queries.length > 0;
  let groups: SearchGroup[] = [];

  if (willSearch && searchProvider) {
    stream.send({
      type: 'searching',
      queries: queries.map((entry) => entry.query),
    });

    try {
      groups = dedupeSearchGroups(await executeSearchPlan(queries, searchProvider));
      if (stream.closed) return;
      stream.send({ type: 'search_results', data: groups });
    } catch (error) {
      // executeSearchPlan is total by design; this is belt-and-braces so a
      // search bug can never turn a planned turn into a 500.
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[chat] search fan-out failed:', detail);
    }
  }

  if (stream.closed) return;

  if (!synthesizer) {
    const note = willSearch
      ? `search complete (${queries.length} ${queries.length === 1 ? 'query' : 'queries'})`
      : searchProvider === null
        ? 'search disabled'
        : 'no search needed';
    stream.send({ type: 'status', text: `${note} — synthesis disabled` });
    stream.send({ type: 'done' });
    stream.end();
    return;
  }

  stream.send({ type: 'status', text: 'writing the answer…' });

  let result: SynthesisResult;
  try {
    result = await synthesizer.run(
      {
        message: input.message,
        now,
        userTz: input.userTz,
        plan,
        recall,
        groups,
        allowedSnapshotIds: new Set([
          ...recallSnapshotIds(recall),
          ...plan.verify_snapshot_ids,
        ]),
        signal: stream.signal,
      },
      (text) => stream.send({ type: 'token', text }),
    );
  } catch (error) {
    if (stream.closed) return;
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[chat] synthesis failed:', detail);
    stream.send({
      type: 'error',
      message: 'Could not finish the answer. Nothing was saved.',
    });
    stream.end();
    return;
  }

  // The client may have left after the last token. A complete answer is only
  // persisted if someone can still be shown it.
  if (stream.closed) return;

  try {
    db.persistAnswer({
      sessionId: input.sessionId,
      content: result.answer,
      createdAt: now.toISOString(),
      snapshot: result.snapshot
        ? {
            label: result.snapshot.label,
            entities: result.snapshot.entities,
            claims: result.snapshot.claims,
            sources: result.snapshot.sources,
            observedAt: now.toISOString(),
            supersedesId: result.snapshot.supersedesId,
          }
        : null,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[chat] failed to persist the answer:', detail);
    stream.send({
      type: 'error',
      message: 'The answer could not be saved, so it was not kept.',
    });
    stream.end();
    return;
  }

  stream.send({ type: 'done' });
  stream.end();
}

export function createChatRouter(deps: ChatRouterDeps): Router {
  const router = Router();
  const planner = deps.planner ?? null;
  const searchProvider = deps.searchProvider ?? null;
  const synthesizer = deps.synthesizer ?? null;
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

    let userMessageId = '';

    try {
      deps.db.upsertSession(sessionId, userTz, at.toISOString());
      const userMessage = deps.db.insertMessage({
        sessionId,
        role: 'user',
        content: message,
        createdAt: at.toISOString(),
      });
      userMessageId = userMessage.id;
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
        deps.db,
        stream,
        planner,
        searchProvider,
        synthesizer,
        { sessionId, message, userTz, userMessageId, memoryIndex },
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
