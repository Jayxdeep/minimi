import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createApp } from '../src/server';
import { createDb, type Db } from '../src/db';
import { chunkReply } from '../src/routes/chat';
import type { SseEvent } from '../src/types';

let db: Db;
let app: Express;

beforeEach(() => {
  db = createDb(':memory:');
  db.migrate();
  app = createApp(db, { chunkDelayMs: 0 });
});

afterEach(() => {
  db.close();
});

function collectSse(body: unknown) {
  return request(app)
    .post('/chat')
    .send(body as object)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks).toString('utf8')));
    });
}

function parseEvents(raw: string): SseEvent[] {
  return raw
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      expect(frame.startsWith('data: ')).toBe(true);
      return JSON.parse(frame.slice('data: '.length)) as SseEvent;
    });
}

function tokenText(events: SseEvent[]): string {
  return events
    .flatMap((event) => (event.type === 'token' ? [event.text] : []))
    .join('');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listen(app: Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe('static app', () => {
  it('serves the chat page', async () => {
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('id="chat"');
  });

  it('404s on unknown routes', async () => {
    const response = await request(app).get('/nope');
    expect(response.status).toBe(404);
  });

  it('reports health', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, db: 'up' });
  });
});

describe('POST /chat', () => {
  it('responds with an SSE stream', async () => {
    const response = await collectSse({ sessionId: 's1', message: 'hello' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toContain('no-cache');
  });

  it('emits data: frames and terminates with done', async () => {
    const response = await collectSse({ sessionId: 's1', message: 'hello' });
    const raw = String(response.body);

    expect(raw).toContain('data: ');

    const events = parseEvents(raw);
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('rejects a malformed body with 400 JSON', async () => {
    const response = await request(app).post('/chat').send({});

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toBe('invalid_request');
  });

  it('rejects an empty message', async () => {
    const response = await request(app)
      .post('/chat')
      .send({ sessionId: 's1', message: '   ' });

    expect(response.status).toBe(400);
  });

  it('streams the echo reply as tokens', async () => {
    const message = 'hello there, general kenobi';
    const response = await collectSse({ sessionId: 's1', message });

    const events = parseEvents(String(response.body));
    expect(tokenText(events)).toBe(`echo: ${message}`);
  });

  it('persists exactly one user row and one assistant row per turn', async () => {
    const message = 'remember this';
    await collectSse({ sessionId: 's1', message });

    const rows = db.listMessagesBySession('s1');
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant']);
    expect(rows[0]?.content).toBe(message);
    expect(rows[1]?.content).toBe(`echo: ${message}`);
  });

  it('creates a session once and reuses it across turns', async () => {
    await collectSse({ sessionId: 's-reuse', message: 'first' });
    await collectSse({ sessionId: 's-reuse', message: 'second' });

    const sessions = db.raw
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM sessions')
      .get();

    expect(sessions?.count).toBe(1);
    expect(db.countMessages('s-reuse')).toBe(4);
  });

  it('does not persist an assistant row when the client disconnects', async () => {
    const slowApp = createApp(db, { chunkDelayMs: 40 });
    const server = await listen(slowApp);

    const message =
      'a deliberately long message that becomes several streamed chunks so the abort happens mid answer';

    try {
      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: server.port,
            path: '/chat',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (response) => {
            response.once('data', () => {
              req.destroy();
              resolve();
            });
          },
        );

        req.on('error', () => {
          /* socket teardown is expected */
        });

        req.end(JSON.stringify({ sessionId: 's-abort', message }));
      });

      await sleep(300);

      const rows = db.listMessagesBySession('s-abort');
      expect(rows.map((row) => row.role)).toEqual(['user']);
    } finally {
      await server.close();
    }
  });
});

describe('chunkReply', () => {
  it('reassembles to the exact original text', () => {
    const samples = [
      'echo: hello',
      'echo: one two three four five six seven eight nine',
      'line one\nline two   with   spaces\ttabbed',
      'trailing whitespace   ',
    ];

    for (const sample of samples) {
      expect(chunkReply(sample).join('')).toBe(sample);
    }
  });

  it('groups roughly four words per chunk', () => {
    expect(chunkReply('one two three four five', 4)).toHaveLength(2);
  });

  it('returns nothing for an empty string', () => {
    expect(chunkReply('')).toEqual([]);
  });
});
