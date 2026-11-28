import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createDb, type Db } from '../src/db';
import { createPlanner } from '../src/planner';
import { createSynthesizer } from '../src/synth';
import type { SearchProvider, SearchResult } from '../src/search/types';
import { createApp } from '../src/server';
import type { PlannerOutput, SseEvent } from '../src/types';
import { FakeLLMClient, synthesisText } from './helpers/fake-llm';

/**
 * Offline eval harness.
 *
 * The model is scripted, but everything around it is real: planner validation,
 * deterministic SQL recall, prompt construction, SSE framing, trailer parsing,
 * citation mapping, and the atomic write. That makes the eval deterministic
 * while still failing if the memory wiring or the change-detection contract
 * regresses.
 */

const NOW = new Date('2026-11-26T12:00:00.000Z'); // Thursday
const NOV_3 = '2026-11-03T09:00:00.000Z';
const NOV_19 = '2026-11-19T09:00:00.000Z';
const MONDAY = ['2026-11-23T00:00:00.000Z', '2026-11-23T23:59:59.999Z'] as const;
const LAST_TUESDAY = [
  '2026-11-24T00:00:00.000Z',
  '2026-11-24T23:59:59.999Z',
] as const;
const NOV_3_WINDOW = [
  '2026-11-03T00:00:00.000Z',
  '2026-11-03T23:59:59.999Z',
] as const;

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
  db.migrate();
  db.upsertSession('eval');
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Seed: the Nov 19 CRM shortlist and the Nov 3 Postgres comparison            */
/* -------------------------------------------------------------------------- */

const CRM_SNAPSHOT_ID = 'snap_crm_nov19';
const POSTGRES_SNAPSHOT_ID = 'snap_pg_nov03';

function seedCrm() {
  db.insertMessage({
    sessionId: 'eval',
    role: 'user',
    content:
      'On Monday we shortlisted 5 CRM tools for a 20-person sales team: ToolA, ToolB, ToolC, ToolD, ToolE.',
    createdAt: NOV_19,
  });
  const assistant = db.insertMessage({
    sessionId: 'eval',
    role: 'assistant',
    content:
      'Shortlist recorded. ToolA $12/user/mo, ToolB $15/user/mo, ToolC $9/user/mo, ToolD $20/user/mo, ToolE $11/user/mo.',
    createdAt: '2026-11-19T09:00:03.000Z',
  });

  db.insertSnapshot({
    id: CRM_SNAPSHOT_ID,
    messageId: assistant.id,
    label: 'CRM shortlist (5 tools)',
    entities: ['ToolA', 'ToolB', 'ToolC', 'ToolD', 'ToolE'],
    claims: [
      { subject: 'ToolA', attribute: 'pricing', value: '$12/user/mo', as_of: '2026-11-18', source_ids: [0], confidence: 0.85 },
      { subject: 'ToolB', attribute: 'pricing', value: '$15/user/mo', as_of: '2026-11-18', source_ids: [1], confidence: 0.85 },
      { subject: 'ToolC', attribute: 'pricing', value: '$9/user/mo', as_of: '2026-11-18', source_ids: [2], confidence: 0.85 },
      { subject: 'ToolD', attribute: 'pricing', value: '$20/user/mo', as_of: '2026-11-18', source_ids: [3], confidence: 0.85 },
      { subject: 'ToolE', attribute: 'pricing', value: '$11/user/mo', as_of: '2026-11-18', source_ids: [4], confidence: 0.85 },
    ],
    sources: ['toola', 'toolb', 'toolc', 'toold', 'toole'].map((tool) => ({
      url: `https://${tool}.example.com/pricing`,
      title: `${tool} pricing`,
      published_date: '2026-11-18',
      retrieved_at: NOV_19,
    })),
    observedAt: '2026-11-19T09:00:03.000Z',
  });
}

function seedPostgres() {
  db.insertMessage({
    sessionId: 'eval',
    role: 'user',
    content: 'Can you compare Supabase and Neon for Postgres hosting?',
    createdAt: NOV_3,
  });
  const assistant = db.insertMessage({
    sessionId: 'eval',
    role: 'assistant',
    content: 'Supabase Pro is $25/mo; Neon Scale is $19/mo.',
    createdAt: '2026-11-03T09:00:02.000Z',
  });

  db.insertSnapshot({
    id: POSTGRES_SNAPSHOT_ID,
    messageId: assistant.id,
    label: 'Postgres hosting pricing',
    entities: ['Supabase', 'Neon'],
    claims: [
      { subject: 'Supabase', attribute: 'pricing', value: 'Pro $25/mo', as_of: '2026-11-02', source_ids: [0], confidence: 0.8 },
      { subject: 'Neon', attribute: 'pricing', value: 'Scale $19/mo', as_of: '2026-11-02', source_ids: [1], confidence: 0.8 },
    ],
    sources: [
      {
        url: 'https://supabase.com/pricing',
        title: 'Supabase pricing',
        published_date: '2026-11-02',
        retrieved_at: NOV_3,
      },
      {
        url: 'https://neon.com/pricing',
        title: 'Neon pricing',
        published_date: '2026-11-02',
        retrieved_at: NOV_3,
      },
    ],
    observedAt: '2026-11-03T09:00:02.000Z',
  });
}

/* -------------------------------------------------------------------------- */
/* Plans and recorded model answers                                           */
/* -------------------------------------------------------------------------- */

function basePlan(): PlannerOutput {
  return {
    intent: 'change',
    now_iso: NOW.toISOString(),
    temporal_refs: [],
    memory: { window: null, keywords: [] },
    search_plan: [],
    verify_snapshot_ids: [],
  };
}

const CRM_PLAN: PlannerOutput = {
  ...basePlan(),
  temporal_refs: [{ expression: 'on Monday', resolved_range: [...MONDAY] }],
  memory: { window: [...MONDAY], keywords: ['crm', 'shortlist', 'pricing'] },
  search_plan: [
    { query: 'ToolA pricing', mode: 'quick' },
    { query: 'ToolB pricing', mode: 'quick' },
    { query: 'ToolC pricing', mode: 'quick' },
  ],
};

const RECALL_PLAN: PlannerOutput = {
  ...basePlan(),
  intent: 'recall',
  temporal_refs: [{ expression: '3 November', resolved_range: [...NOV_3_WINDOW] }],
  memory: { window: [...NOV_3_WINDOW], keywords: ['postgres', 'hosting', 'pricing'] },
  search_plan: [
    { query: 'Supabase pricing', mode: 'quick' },
    { query: 'Neon pricing', mode: 'quick' },
  ],
  verify_snapshot_ids: [POSTGRES_SNAPSHOT_ID],
};

const LAST_TUESDAY_PLAN: PlannerOutput = {
  ...basePlan(),
  temporal_refs: [{ expression: 'last Tuesday', resolved_range: [...LAST_TUESDAY] }],
  memory: {
    window: [...LAST_TUESDAY],
    keywords: ['postgres', 'hosting', 'pricing'],
  },
  search_plan: [
    { query: 'Supabase pricing', mode: 'quick' },
    { query: 'Neon pricing', mode: 'quick' },
  ],
};

const CRM_TRAILER = {
  label: 'CRM shortlist pricing',
  entities: ['ToolA', 'ToolB', 'ToolC'],
  claims: [
    { subject: 'ToolA', attribute: 'pricing', value: '$14/user/mo', as_of: '2026-11-25', source_ids: [1], confidence: 0.9 },
    { subject: 'ToolB', attribute: 'pricing', value: '$15/user/mo', as_of: '2026-11-20', source_ids: [2], confidence: 0.9 },
  ],
  used_sources: [1, 2],
  supersedes_id: CRM_SNAPSHOT_ID,
};

const CRM_ANSWER = `**Changed** — ToolA was $12/user/mo on 19 Nov; it is now $14/user/mo [1].

**Unchanged** — ToolB: no change observed since 19 Nov; it is still $15/user/mo [2].

**Couldn't verify** — ToolC: no current source was returned, so I can't confirm its price.`;

const PG_TRAILER = {
  label: 'Postgres hosting pricing',
  entities: ['Supabase', 'Neon'],
  claims: [
    { subject: 'Neon', attribute: 'pricing', value: 'Scale $24/mo', as_of: '2026-11-25', source_ids: [2], confidence: 0.9 },
    { subject: 'Supabase', attribute: 'pricing', value: 'Pro $25/mo', as_of: '2026-11-24', source_ids: [1], confidence: 0.9 },
  ],
  used_sources: [1, 2],
  supersedes_id: POSTGRES_SNAPSHOT_ID,
};

const PG_ANSWER = `**Changed** — Neon was $19/mo on 3 Nov; it is now $24/mo [2].

**Unchanged** — Supabase: no change observed since 3 Nov; it is still $25/mo [1].`;

/* -------------------------------------------------------------------------- */
/* Fake search                                                                */
/* -------------------------------------------------------------------------- */

const SEARCH: Record<string, SearchResult[]> = {
  'ToolA pricing': [
    {
      url: 'https://toola.example.com/pricing',
      title: 'ToolA pricing',
      snippet: 'Pro is now $14 per user per month.',
      publishedDate: '2026-11-25',
    },
  ],
  'ToolB pricing': [
    {
      url: 'https://toolb.example.com/pricing',
      title: 'ToolB pricing',
      snippet: 'Team is $15 per user per month.',
      publishedDate: '2026-11-20',
    },
  ],
  'ToolC pricing': [],
  'Supabase pricing': [
    {
      url: 'https://supabase.com/pricing',
      title: 'Supabase pricing',
      snippet: 'Pro is $25/mo.',
      publishedDate: '2026-11-24',
    },
  ],
  'Neon pricing': [
    {
      url: 'https://neon.com/pricing',
      title: 'Neon pricing',
      snippet: 'Scale is $24/mo.',
      publishedDate: '2026-11-25',
    },
  ],
};

function fakeProvider(): SearchProvider & { search: ReturnType<typeof vi.fn> } {
  const search = vi.fn(async (query: string) => SEARCH[query] ?? []);
  return { search };
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

function parseEvents(raw: string): SseEvent[] {
  return raw
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0)
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as SseEvent);
}

function tokenText(events: SseEvent[]): string {
  return events
    .flatMap((event) => (event.type === 'token' ? [event.text] : []))
    .join('');
}

function collectSse(target: Express, body: object) {
  return request(target)
    .post('/chat')
    .send(body)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks).toString('utf8')));
    });
}

async function runTurn(input: {
  sessionId: string;
  message: string;
  plan: PlannerOutput;
  answer: string;
  provider?: SearchProvider;
}) {
  const llm = new FakeLLMClient(
    [JSON.stringify(input.plan)],
    [input.answer],
  );
  const provider = input.provider ?? fakeProvider();

  const app = createApp(db, {
    chunkDelayMs: 0,
    planner: createPlanner(llm),
    synthesizer: createSynthesizer(llm),
    searchProvider: provider,
    now: () => NOW,
  });

  const response = await collectSse(app, {
    sessionId: input.sessionId,
    message: input.message,
    userTz: 'Europe/London',
  });

  const events = parseEvents(String(response.body));
  return { events, streamed: tokenText(events), llm, provider };
}

function synthesizerPrompt(llm: FakeLLMClient): string {
  return llm.streamCalls[0]?.messages[1]?.content ?? '';
}

function snapshotsAt(instant: string) {
  return db.findSnapshotsByTimeRange(instant, instant);
}

/* -------------------------------------------------------------------------- */
/* Evals                                                                      */
/* -------------------------------------------------------------------------- */

describe('eval: the three canonical queries', () => {
  it('query 1 — CRM shortlist: Changed, Unchanged and Couldn\'t verify', async () => {
    seedCrm();

    const { events, streamed, llm } = await runTurn({
      sessionId: 'q1',
      message:
        'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
      plan: CRM_PLAN,
      answer: synthesisText(CRM_ANSWER, CRM_TRAILER),
    });

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done' });

    expect(streamed).toContain('**Changed**');
    expect(streamed).toContain('**Unchanged**');
    expect(streamed).toContain("**Couldn't verify**");

    // Keyword recall bridged the Monday window to the Thursday shortlist.
    const prompt = synthesizerPrompt(llm);
    expect(prompt).toContain(CRM_SNAPSHOT_ID);
    expect(prompt).toContain('$12/user/mo');
    expect(prompt).toContain('ToolA / pricing');

    const [snapshot] = snapshotsAt(NOW.toISOString());
    expect(snapshot).toBeDefined();
    expect(snapshot?.supersedesId).toBe(CRM_SNAPSHOT_ID);
    expect(snapshot?.claims.map((claim) => claim.subject)).toEqual([
      'ToolA',
      'ToolB',
    ]);
    expect(snapshot?.sources.map((source) => source.url)).toEqual([
      'https://toola.example.com/pricing',
      'https://toolb.example.com/pricing',
    ]);
  });

  it('query 2 — what did I ask on 3 November, and is it still true', async () => {
    seedPostgres();

    const { events, streamed, llm } = await runTurn({
      sessionId: 'q2',
      message:
        'What did I ask you on 3 November? Is your answer still correct today?',
      plan: RECALL_PLAN,
      answer: synthesisText(PG_ANSWER, PG_TRAILER),
    });

    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(streamed).toContain('**Changed**');
    expect(streamed).toContain('**Unchanged**');

    const prompt = synthesizerPrompt(llm);
    expect(prompt).toContain('Can you compare Supabase and Neon for Postgres hosting?');
    expect(prompt).toContain(POSTGRES_SNAPSHOT_ID);
    expect(prompt).toContain('Scale $19/mo');
    expect(prompt).toContain('Pro $25/mo');

    const [snapshot] = snapshotsAt(NOW.toISOString());
    expect(snapshot?.supersedesId).toBe(POSTGRES_SNAPSHOT_ID);
    expect(snapshot?.claims[0]?.value).toBe('Scale $24/mo');
  });

  it('query 3 — last Tuesday: keyword recall beats a wrong window', async () => {
    seedPostgres();

    const { events, streamed, llm } = await runTurn({
      sessionId: 'q3',
      message:
        'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
      plan: LAST_TUESDAY_PLAN,
      answer: synthesisText(PG_ANSWER, PG_TRAILER),
    });

    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(streamed).toContain('**Changed**');

    const prompt = synthesizerPrompt(llm);
    expect(prompt).toContain(POSTGRES_SNAPSHOT_ID);
    expect(prompt).toContain('observed 2026-11-03T09:00:02.000Z');

    const [snapshot] = snapshotsAt(NOW.toISOString());
    expect(snapshot?.supersedesId).toBe(POSTGRES_SNAPSHOT_ID);
  });
});

describe('eval: pasted text', () => {
  it('plans no search even when the model asks for one', async () => {
    const pasted = `Here is the document I need summarised:\n\n${'The quarterly report shows steady growth in every region. '.repeat(12)}\n\nSummarize this.`;

    expect(pasted.length).toBeGreaterThan(500);

    const planWithSearch: PlannerOutput = {
      ...basePlan(),
      intent: 'lookup',
      memory: { window: null, keywords: ['report'] },
      search_plan: [{ query: 'quarterly report summary', mode: 'quick' }],
    };

    const provider = fakeProvider();

    const { events, streamed, llm } = await runTurn({
      sessionId: 'summary',
      message: pasted,
      plan: planWithSearch,
      answer: synthesisText(
        '**Summary** — The report describes steady growth in every region.',
        {
          label: 'Quarterly report summary',
          entities: [],
          claims: [],
          used_sources: [],
          supersedes_id: null,
        },
      ),
      provider,
    });

    const planEvent = events.find((event) => event.type === 'plan');
    if (planEvent?.type !== 'plan') throw new Error('expected a plan event');
    expect(planEvent.plan.intent).toBe('chat');
    expect(planEvent.plan.search_plan).toEqual([]);

    expect(events.some((event) => event.type === 'searching')).toBe(false);
    expect(provider.search).not.toHaveBeenCalled();
    expect(streamed).toContain('**Summary**');

    expect(synthesizerPrompt(llm)).toContain('The quarterly report shows steady growth');

    // No sources and no claims: the episode is kept, the snapshot is not.
    expect(snapshotsAt(NOW.toISOString())).toHaveLength(0);
    expect(db.listMessagesBySession('summary')).toHaveLength(2);
  });

  it('never recalls memory when the message is a pasted document', async () => {
    // Memory exists and the plan asks for it; the turn must still ignore it.
    seedCrm();

    const pasted = `Here is a page I copied:\n\n${'ToolA costs $12 per user per month and includes three pipelines. '.repeat(12)}\n\nSummarize this whole thing.`;
    expect(pasted.length).toBeGreaterThan(500);

    const planWithRecall: PlannerOutput = {
      ...basePlan(),
      intent: 'recall',
      temporal_refs: [
        { expression: '19 November', resolved_range: [NOV_19, NOV_19] },
      ],
      memory: {
        window: [NOV_19, '2026-11-19T23:59:59.999Z'],
        keywords: ['crm', 'shortlist'],
      },
      search_plan: [{ query: 'crm pricing', mode: 'quick' }],
      verify_snapshot_ids: [CRM_SNAPSHOT_ID],
    };

    const provider = fakeProvider();

    const { events, streamed, llm } = await runTurn({
      sessionId: 'pasted-with-memory',
      message: pasted,
      plan: planWithRecall,
      answer: synthesisText(
        '**Summary** — The pasted page lists one plan at $12 per user per month with three pipelines.',
        {
          label: 'Pasted page summary',
          entities: [],
          claims: [],
          used_sources: [],
          supersedes_id: null,
        },
      ),
      provider,
    });

    const planEvent = events.find((event) => event.type === 'plan');
    if (planEvent?.type !== 'plan') throw new Error('expected a plan event');

    expect(planEvent.plan.intent).toBe('chat');
    expect(planEvent.plan.memory.window).toBeNull();
    expect(planEvent.plan.memory.keywords).toEqual([]);
    expect(planEvent.plan.search_plan).toEqual([]);
    expect(planEvent.plan.verify_snapshot_ids).toEqual([]);

    expect(events.some((event) => event.type === 'searching')).toBe(false);
    expect(provider.search).not.toHaveBeenCalled();

    const prompt = synthesizerPrompt(llm);
    expect(prompt).toContain('Here is a page I copied');
    expect(prompt).toContain('(no stored memories matched this question)');
    expect(prompt).not.toContain(CRM_SNAPSHOT_ID);
    expect(prompt).not.toContain('$12/user/mo');

    expect(streamed).toContain('**Summary**');
    expect(streamed).not.toContain('CRM shortlist');

    // The memory was genuinely present; the turn chose not to inject it.
    expect(db.getSnapshot(CRM_SNAPSHOT_ID)).toBeDefined();
    expect(snapshotsAt(NOW.toISOString())).toHaveLength(0);
  });
});

describe('eval: missing memory must not be invented', () => {
  it('says it has no record and creates no evidence', async () => {
    // Deliberately empty database: no episodes, no snapshots.
    const answer = synthesisText(
      'I have no record of a conversation on 3 November, so I cannot check whether that answer is still correct.',
      {
        label: 'Missing conversation',
        entities: [],
        claims: [
          {
            subject: 'Supabase',
            attribute: 'pricing',
            value: '$25/mo',
            as_of: null,
            source_ids: [1],
            confidence: 0.9,
          },
        ],
        used_sources: [1],
        supersedes_id: null,
      },
    );

    const { events, streamed, llm } = await runTurn({
      sessionId: 'q2-empty',
      message:
        'What did I ask you on 3 November? Is your answer still correct today?',
      plan: RECALL_PLAN,
      answer,
      // No memory and no sources: nothing exists to cite.
      provider: { search: async () => [] },
    });

    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(streamed).toContain('no record');

    expect(synthesizerPrompt(llm)).toContain(
      '(no stored memories matched this question)',
    );

    // The model tried to cite a nonexistent source; nothing was stored.
    expect(snapshotsAt(NOW.toISOString())).toHaveLength(0);
    expect(db.listMessagesBySession('q2-empty')).toHaveLength(2);
  });
});
