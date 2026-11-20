import type { Response } from 'express';
import type { SseEvent } from './types';

export interface SseStream {
  /** True once the client has gone away (or we ended the stream). */
  readonly closed: boolean;
  /** Aborted when the client disconnects, so in-flight model calls can stop. */
  readonly signal: AbortSignal;
  send(event: SseEvent): void;
  end(): void;
}

/**
 * Open an SSE response and hand back a guarded writer.
 *
 * Writes are dropped after close/end instead of throwing
 * ERR_STREAM_WRITE_AFTER_END, which is what makes the abort path safe.
 */
export function openSse(res: Response): SseStream {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);

  let closed = false;
  let ended = false;
  const abort = new AbortController();

  res.on('close', () => {
    closed = true;
    abort.abort();
  });

  return {
    get closed() {
      return closed || ended;
    },

    get signal() {
      return abort.signal;
    },

    send(event) {
      if (closed || ended) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },

    end() {
      if (closed || ended) return;
      ended = true;
      res.end();
    },
  };
}
