import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createApp } from '../src/server';
import { createDb, type Db } from '../src/db';
import { createPlanner } from '../src/planner';
import { chunkReply } from '../src/routes/chat';
import type { SearchProvider } from '../src/search/types';
import type { SseEvent } from '../src/types';
import { FIXED_NOW, FakeLLMClient, plannerJson } from './helpers/fake-llm';

let db: Db;
let app: Express;

beforeEach(() => {
  db = createDb(':memory:');
  db.migrate();
  app = createApp(db, { chunkDelayMs: 0 });
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function collectSseFrom(target: Express, body: unknown) {
  return request(target)
    .post('/chat')
    .send(body as object)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks).toString('utf8')));
    });
}

function collectSse(body: unknown) {
  return collectSseFrom(app, body);
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

  it('serves the split frontend assets', async () => {
    const css = await request(app).get('/styles.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');

    for (const asset of ['/js/main.js', '/js/ui.js', '/js/sse.js', '/js/api.js']) {
      const js = await request(app).get(asset);
      expect(js.status, asset).toBe(200);
      expect(js.headers['content-type'], asset).toContain('javascript');
    }
  });

  it('keeps index.html free of inline css and js', async () => {
    const response = await request(app).get('/');
    const html = response.text;

    expect(html).toContain('href="/styles.css"');
    expect(html).not.toContain('<style');

    const scripts = html.match(/<script[^>]*>/g) ?? [];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('src="/js/main.js"');
    expect(scripts[0]).toContain('type="module"');
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

describe('POST /chat with a planner', () => {
  function plannedApp(responses: Array<string | Error>) {
    const llm = new FakeLLMClient(responses);
    const planned = createApp(db, {
      chunkDelayMs: 0,
      planner: createPlanner(llm),
      now: () => FIXED_NOW,
    });
    return { app: planned, llm };
  }

  function planFrom(events: SseEvent[]) {
    const event = events.find((candidate) => candidate.type === 'plan');
    if (event?.type !== 'plan') throw new Error('expected a plan event');
    return event.plan;
  }

  it('emits a plan frame and persists no assistant answer yet', async () => {
    const { app: planned } = plannedApp([plannerJson()]);

    const response = await collectSseFrom(planned, {
      sessionId: 's-plan',
      message: 'has postgres hosting pricing changed?',
    });

    const events = parseEvents(String(response.body));
    const plan = planFrom(events);

    expect(plan.intent).toBe('change');
    expect(plan.now_iso).toBe(FIXED_NOW.toISOString());
    expect(plan.search_plan[0]?.query).toBe('Supabase pricing');

    expect(events.some((event) => event.type === 'token')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done' });

    // Phase 1 deliberately remembers only the question.
    expect(db.listMessagesBySession('s-plan').map((row) => row.role)).toEqual([
      'user',
    ]);
  });

  it('degrades to a chat plan when the planner fails twice', async () => {
    const { app: planned, llm } = plannedApp(['not json', '{"intent":"nope"}']);

    const response = await collectSseFrom(planned, {
      sessionId: 's-degraded',
      message: 'hello',
    });

    const events = parseEvents(String(response.body));
    const plan = planFrom(events);

    expect(plan.intent).toBe('chat');
    expect(plan.search_plan).toEqual([]);
    expect(
      events.some(
        (event) => event.type === 'status' && /degraded/.test(event.text),
      ),
    ).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(llm.callCount).toBe(2);
  });

  it('shows stored snapshots to the planner and filters invented ids', async () => {
    db.upsertSession('prior-session');
    const prior = db.insertMessage({
      sessionId: 'prior-session',
      role: 'assistant',
      content: 'Supabase Pro is $25/mo.',
      createdAt: '2026-11-17T09:00:00.000Z',
    });
    const snapshot = db.insertSnapshot({
      messageId: prior.id,
      label: 'Postgres hosting',
      entities: ['Supabase'],
      claims: [
        {
          subject: 'Supabase',
          attribute: 'pricing',
          value: '$25/mo',
          as_of: '2026-11-10',
          source_ids: [0],
          confidence: 0.8,
        },
      ],
      sources: [
        {
          url: 'https://supabase.com/pricing',
          title: 'Pricing',
          retrieved_at: '2026-11-17T09:00:00.000Z',
        },
      ],
      observedAt: '2026-11-17T09:00:00.000Z',
    });

    const { app: planned, llm } = plannedApp([
      plannerJson({ verify_snapshot_ids: [snapshot.id, 'snap_invented'] }),
    ]);

    const response = await collectSseFrom(planned, {
      sessionId: 's-verify',
      message: 'is that still correct?',
    });

    const plan = planFrom(parseEvents(String(response.body)));
    expect(plan.verify_snapshot_ids).toEqual([snapshot.id]);

    const prompt = llm.calls[0]?.messages[1]?.content ?? '';
    expect(prompt).toContain(snapshot.id);
    expect(prompt).toContain('Supabase/pricing');
  });

  it('passes the browser timezone through to the planner', async () => {
    const { app: planned, llm } = plannedApp([plannerJson()]);

    await collectSseFrom(planned, {
      sessionId: 's-tz',
      message: 'what did I ask last Tuesday?',
      userTz: 'Asia/Kolkata',
    });

    const prompt = llm.calls[0]?.messages[1]?.content ?? '';
    expect(prompt).toContain('Asia/Kolkata');
    expect(prompt).toContain('NOW_LOCAL:');
  });
});

describe('POST /chat with search', () => {
  function twoQueryPlan(): string {
    return plannerJson({
      search_plan: [
        { query: 'Supabase pricing', mode: 'quick', since: '2026-11-10' },
        { query: 'Neon pricing', mode: 'news' },
      ],
    });
  }

  function searchApp(
    provider: SearchProvider | null,
    plan: string = twoQueryPlan(),
  ) {
    const llm = new FakeLLMClient([plan]);
    return createApp(db, {
      chunkDelayMs: 0,
      planner: createPlanner(llm),
      searchProvider: provider,
      now: () => FIXED_NOW,
    });
  }

  it('emits searching then grouped results between plan and done', async () => {
    const provider: SearchProvider = {
      async search(query) {
        return [
          {
            url: `https://example.com/${encodeURIComponent(query)}`,
            title: `${query} result`,
            snippet: 'a snippet',
          },
        ];
      },
    };

    const response = await collectSseFrom(searchApp(provider), {
      sessionId: 's-search',
      message: 'has postgres hosting pricing changed?',
    });

    const events = parseEvents(String(response.body));

    expect(events.map((event) => event.type)).toEqual([
      'status',
      'plan',
      'searching',
      'search_results',
      'status',
      'done',
    ]);

    const searching = events[2];
    if (searching?.type !== 'searching') throw new Error('expected searching');
    expect(searching.queries).toEqual(['Supabase pricing', 'Neon pricing']);

    const results = events[3];
    if (results?.type !== 'search_results') {
      throw new Error('expected search_results');
    }
    expect(results.data).toHaveLength(2);
    expect(results.data[0]?.query).toBe('Supabase pricing');
    expect(results.data[1]?.query).toBe('Neon pricing');
    expect(results.data[0]?.results[0]?.url).toContain('Supabase');
  });

  it('skips search when the plan has no queries', async () => {
    const search = vi.fn(async () => []);
    const response = await collectSseFrom(
      searchApp({ search }, plannerJson({ search_plan: [] })),
      { sessionId: 's-nosearch', message: 'hello there' },
    );

    const events = parseEvents(String(response.body));

    expect(events.some((event) => event.type === 'searching')).toBe(false);
    expect(events.some((event) => event.type === 'search_results')).toBe(false);
    expect(search).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('skips search when no provider is configured', async () => {
    const response = await collectSseFrom(searchApp(null), {
      sessionId: 's-noprovider',
      message: 'compare hosting',
    });

    const events = parseEvents(String(response.body));

    expect(events.some((event) => event.type === 'searching')).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === 'status' && event.text.includes('search disabled'),
      ),
    ).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('still completes when every query fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const provider: SearchProvider = {
      async search() {
        throw new Error('upstream down');
      },
    };

    const response = await collectSseFrom(searchApp(provider), {
      sessionId: 's-search-fail',
      message: 'compare hosting',
    });

    const events = parseEvents(String(response.body));
    const results = events.find((event) => event.type === 'search_results');

    if (results?.type !== 'search_results') {
      throw new Error('expected search_results even on failure');
    }

    expect(results.data).toHaveLength(2);
    expect(results.data.every((group) => group.results.length === 0)).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });
});
