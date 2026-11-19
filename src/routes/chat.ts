import { Router } from 'express';
import type { Db } from '../db';
import { openSse } from '../sse';
import { ChatRequestSchema } from '../types';

export interface ChatRouterOptions {
  /** Delay between streamed chunks. 0 in tests. */
  chunkDelayMs: number;
}

export function createChatRouter(_db: Db, _options: ChatRouterOptions): Router {
  const router = Router();

  router.post('/chat', (req, res) => {
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

    // Phase 0.3: transport only. Echo arrives in 0.4.
    const stream = openSse(res);
    stream.send({ type: 'done' });
    stream.end();
  });

  return router;
}
