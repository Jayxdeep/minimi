import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/server';
import { createDb, type Db } from '../src/db';
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
});
