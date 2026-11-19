import { Router } from 'express';
import type { Db } from '../db';
import { openSse } from '../sse';
import { ChatRequestSchema } from '../types';

export interface ChatRouterOptions {
  /** Delay between streamed chunks. 0 in tests. */
  chunkDelayMs: number;
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

export function createChatRouter(db: Db, options: ChatRouterOptions): Router {
  const router = Router();

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

    const { sessionId, message, userTz } = parsed.data;
    const stream = openSse(res);

    try {
      db.upsertSession(sessionId, userTz);
      db.insertMessage({ sessionId, role: 'user', content: message });

      stream.send({ type: 'status', text: 'thinking…' });

      // Phase 0.4: echo. The shape of this loop is the final one: tokens out,
      // then one state write, then done.
      const reply = `echo: ${message}`;

      for (const chunk of chunkReply(reply)) {
        if (stream.closed) return;
        stream.send({ type: 'token', text: chunk });
        if (options.chunkDelayMs > 0) await sleep(options.chunkDelayMs);
      }

      // A client that left mid-answer gets no assistant row: we never persist
      // a partial answer, because a snapshot must describe a complete one.
      if (stream.closed) return;

      db.insertMessage({ sessionId, role: 'assistant', content: reply });
      stream.send({ type: 'done' });
      stream.end();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[chat] turn failed:', detail);
      stream.send({ type: 'error', message: 'Something went wrong on the server.' });
      stream.end();
    }
  });

  return router;
}
