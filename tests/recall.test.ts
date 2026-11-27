import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db';
import { formatRecall, recallMemory } from '../src/recall';
import type { PlannerOutput, Snapshot } from '../src/types';

let db: Db;

const POSTGRES_AT = '2026-11-03T09:00:00.000Z';
const CRM_AT = '2026-11-19T09:00:00.000Z';
const NOW = new Date('2026-11-26T12:00:00.000Z');

beforeEach(() => {
  db = createDb(':memory:');
  db.migrate();
  db.upsertSession('s1');
});

afterEach(() => {
  db.close();
});

function plan(overrides: Partial<PlannerOutput> = {}): PlannerOutput {
  return {
    intent: 'change',
    now_iso: NOW.toISOString(),
    temporal_refs: [],
    memory: { window: null, keywords: [] },
    search_plan: [],
    verify_snapshot_ids: [],
    ...overrides,
  };
}

function seedPostgres(): {
  user: ReturnType<Db['insertMessage']>;
  assistant: ReturnType<Db['insertMessage']>;
  snapshot: Snapshot;
} {
  const user = db.insertMessage({
    sessionId: 's1',
    role: 'user',
    content: 'Can you compare Supabase and Neon for Postgres hosting?',
    createdAt: POSTGRES_AT,
  });
  const assistant = db.insertMessage({
    sessionId: 's1',
    role: 'assistant',
    content: 'Supabase Pro is $25/mo; Neon Scale is $19/mo.',
    createdAt: '2026-11-03T09:00:02.000Z',
  });
  const snapshot = db.insertSnapshot({
    messageId: assistant.id,
    label: 'Postgres hosting pricing',
    entities: ['Supabase', 'Neon'],
    claims: [
      {
        subject: 'Supabase',
        attribute: 'pricing',
        value: 'Pro $25/mo',
        as_of: '2026-11-02',
        source_ids: [0],
        confidence: 0.8,
      },
      {
        subject: 'Neon',
        attribute: 'pricing',
        value: 'Scale $19/mo',
        as_of: '2026-11-02',
        source_ids: [1],
        confidence: 0.8,
      },
    ],
    sources: [
      {
        url: 'https://supabase.com/pricing',
        title: 'Supabase pricing',
        published_date: '2026-11-02',
        retrieved_at: POSTGRES_AT,
      },
      {
        url: 'https://neon.com/pricing',
        title: 'Neon pricing',
        published_date: '2026-11-02',
        retrieved_at: POSTGRES_AT,
      },
    ],
    observedAt: '2026-11-03T09:00:05.000Z',
  });

  return { user, assistant, snapshot };
}

function seedCrm(): Snapshot {
  const assistant = db.insertMessage({
    sessionId: 's1',
    role: 'assistant',
    content: 'CRM shortlist: ToolA, ToolB, ToolC, ToolD, ToolE.',
    createdAt: CRM_AT,
  });

  return db.insertSnapshot({
    messageId: assistant.id,
    label: 'CRM shortlist (5 tools)',
    entities: ['ToolA', 'ToolB', 'ToolC', 'ToolD', 'ToolE'],
    claims: [
      {
        subject: 'ToolA',
        attribute: 'pricing',
        value: '$12/user/mo',
        as_of: '2026-11-18',
        source_ids: [0],
        confidence: 0.8,
      },
    ],
    sources: [
      {
        url: 'https://example.com/toola',
        title: 'ToolA pricing',
        published_date: '2026-11-18',
        retrieved_at: CRM_AT,
      },
    ],
    observedAt: CRM_AT,
  });
}

describe('recallMemory', () => {
  it('loads episodes and snapshots inside the planner window', () => {
    const { user, snapshot } = seedPostgres();
    seedCrm();

    const recall = recallMemory(
      db,
      plan({
        memory: {
          window: ['2026-11-03T00:00:00.000Z', '2026-11-03T23:59:59.999Z'],
          keywords: [],
        },
      }),
    );

    expect(recall.episodes.map((message) => message.id)).toContain(user.id);
    expect(recall.snapshots.map((entry) => entry.id)).toEqual([snapshot.id]);
  });

  it('finds memory by keyword when the window misses it', () => {
    const { snapshot } = seedPostgres();
    const crm = seedCrm();

    const recall = recallMemory(
      db,
      plan({
        memory: {
          window: ['2026-11-23T00:00:00.000Z', '2026-11-23T23:59:59.999Z'],
          keywords: ['crm', 'shortlist'],
        },
      }),
    );

    expect(recall.snapshots.map((entry) => entry.id)).toEqual([crm.id]);
    expect(recall.snapshots.map((entry) => entry.id)).not.toContain(snapshot.id);
  });

  it('always loads explicitly re-verified snapshots, even outside any window', () => {
    const { snapshot } = seedPostgres();

    const recall = recallMemory(
      db,
      plan({ verify_snapshot_ids: [snapshot.id] }),
    );

    expect(recall.snapshots.map((entry) => entry.id)).toEqual([snapshot.id]);
  });

  it('links snapshots to recalled episodes', () => {
    const { snapshot } = seedPostgres();

    // The window covers both episode messages but ends before the snapshot's
    // observed_at; the snapshot still arrives through the message link.
    const recall = recallMemory(
      db,
      plan({
        memory: {
          window: ['2026-11-03T09:00:00.000Z', '2026-11-03T09:00:03.000Z'],
          keywords: [],
        },
      }),
    );

    expect(recall.episodes).toHaveLength(2);
    expect(recall.snapshots.map((entry) => entry.id)).toEqual([snapshot.id]);
  });

  it('never treats the current turn as memory', () => {
    const { user } = seedPostgres();

    const recall = recallMemory(
      db,
      plan({
        memory: {
          window: ['2026-11-03T00:00:00.000Z', '2026-11-03T23:59:59.999Z'],
          keywords: [],
        },
      }),
      { excludeMessageId: user.id },
    );

    expect(recall.episodes.map((message) => message.id)).not.toContain(user.id);
  });

  it('keeps explicitly verified snapshots when capping', () => {
    const { snapshot } = seedPostgres();

    for (let index = 0; index < 10; index += 1) {
      const message = db.insertMessage({
        sessionId: 's1',
        role: 'assistant',
        content: `other ${index}`,
        createdAt: `2026-11-2${index % 10}T09:00:00.000Z`,
      });
      db.insertSnapshot({
        messageId: message.id,
        label: `Other ${index}`,
        entities: [],
        claims: [],
        sources: [],
        observedAt: `2026-11-2${index % 10}T09:00:00.000Z`,
      });
    }

    const recall = recallMemory(
      db,
      plan({
        verify_snapshot_ids: [snapshot.id],
        memory: { window: null, keywords: ['other'] },
      }),
      { maxSnapshots: 3 },
    );

    expect(recall.snapshots).toHaveLength(3);
    expect(recall.snapshots.map((entry) => entry.id)).toContain(snapshot.id);
  });
});

describe('formatRecall', () => {
  it('includes claim values, dates, chains and source URLs', () => {
    const { snapshot } = seedPostgres();

    const text = formatRecall({
      episodes: [],
      snapshots: [{ ...snapshot, supersedesId: 'snap_prev' }],
    });

    expect(text).toContain(snapshot.id);
    expect(text).toContain('supersedes snap_prev');
    expect(text).toContain('Supabase / pricing = "Pro $25/mo"');
    expect(text).toContain('https://supabase.com/pricing');
    expect(text).toContain('as_of 2026-11-02');
  });

  it('says there is no memory instead of inventing any', () => {
    expect(formatRecall({ episodes: [], snapshots: [] })).toBe(
      '(no stored memories matched this question)',
    );
  });
});
