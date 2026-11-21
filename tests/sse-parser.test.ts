import { describe, expect, it, vi } from 'vitest';
import { createSseParser, readSse } from '../public/js/sse.js';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function responseFromChunks(chunks: Uint8Array[]): Response {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  } as unknown as Response;
}

describe('createSseParser', () => {
  it('emits a complete frame', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));

    parser.push('data: {"type":"status","text":"planning…"}\n\n');

    expect(events).toEqual([{ type: 'status', text: 'planning…' }]);
  });

  it('reassembles a frame split mid-JSON', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));

    parser.push('data: {"type":"tok');
    parser.push('en","text":"hel');
    parser.push('lo"}\n\n');

    expect(events).toEqual([{ type: 'token', text: 'hello' }]);
  });

  it('emits several frames from one chunk', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));

    parser.push(
      'data: {"type":"token","text":"a"}\n\ndata: {"type":"done"}\n\n',
    );

    expect(events).toEqual([
      { type: 'token', text: 'a' },
      { type: 'done' },
    ]);
  });

  it('handles CRLF split across chunks', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));

    parser.push('data: {"type":"done"}\r');
    parser.push('\n\r\n');

    expect(events).toEqual([{ type: 'done' }]);
  });

  it('joins multi-line data fields', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));

    parser.push('data: {"type":\ndata: "done"}\n\n');

    expect(events).toEqual([{ type: 'done' }]);
  });

  it('drops malformed frames without killing the stream', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));

    parser.push('data: not json\n\n');
    parser.push('data: {"type":"done"}\n\n');

    expect(events).toEqual([{ type: 'done' }]);
  });

  it('ignores comments and unknown fields', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));

    parser.push(': heartbeat\n\nevent: ping\n\ndata: {"type":"done"}\n\n');

    expect(events).toEqual([{ type: 'done' }]);
  });

  it('lets handler errors propagate (error events are terminal)', () => {
    const parser = createSseParser(() => {
      throw new Error('server said no');
    });

    expect(() => parser.push('data: {"type":"error","message":"x"}\n\n')).toThrow(
      'server said no',
    );
  });

  it('flushes a trailing frame with no blank line', () => {
    const events: unknown[] = [];
    const parser = createSseParser((event) => events.push(event));

    parser.push('data: {"type":"done"}');
    expect(events).toEqual([]);

    parser.flush();
    expect(events).toEqual([{ type: 'done' }]);
  });
});

describe('readSse', () => {
  it('streams events in order from a chunked body', async () => {
    const onEvent = vi.fn();

    await readSse(
      responseFromChunks([
        bytes('data: {"type":"status","text":"thinking"}\n\ndata: {"type":"tok'),
        bytes('en","text":"hi"}\n\n'),
        bytes('data: {"type":"done"}\n\n'),
      ]),
      onEvent,
    );

    expect(onEvent.mock.calls.map((call) => call[0])).toEqual([
      { type: 'status', text: 'thinking' },
      { type: 'token', text: 'hi' },
      { type: 'done' },
    ]);
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const full = bytes('data: {"type":"token","text":"🙂"}\n\n');
    const cut = full.indexOf(0xf0) + 2;

    const onEvent = vi.fn();
    await readSse(
      responseFromChunks([full.slice(0, cut), full.slice(cut)]),
      onEvent,
    );

    expect(onEvent).toHaveBeenCalledWith({ type: 'token', text: '🙂' });
  });

  it('rejects when the response has no body', async () => {
    await expect(readSse({} as Response, () => {})).rejects.toThrow(
      'no body to stream',
    );
  });

  it('propagates a terminal error event', async () => {
    const stream = responseFromChunks([
      bytes('data: {"type":"error","message":"boom"}\n\n'),
    ]);

    await expect(
      readSse(stream, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
