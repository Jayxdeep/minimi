import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, deriveTopicKey, type Db } from '../src/db';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
  db.migrate();
  db.upsertSession('s1');
});

afterEach(() => {
  db.close();
});

function columns(table: string): string[] {
  return db.raw
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

describe('migrations', () => {
  it('is idempotent', () => {
    expect(() => db.migrate()).not.toThrow();

    const tables = db.raw
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining(['messages', 'sessions', 'snapshots', 'messages_fts']),
    );
    expect(tables.filter((name) => name === 'messages')).toHaveLength(1);
  });

  it('creates the expected columns', () => {
    expect(columns('sessions')).toEqual(
      expect.arrayContaining(['id', 'started_at', 'user_tz']),
    );
    expect(columns('messages')).toEqual(
      expect.arrayContaining(['id', 'session_id', 'role', 'content', 'created_at']),
    );
    expect(columns('snapshots')).toEqual(
      expect.arrayContaining([
        'id',
        'message_id',
        'label',
        'topic_key',
        'entities_json',
        'claims_json',
        'sources_json',
        'observed_at',
        'supersedes_id',
      ]),
    );
    // We deliberately do not store an unknowable "valid_from".
    expect(columns('snapshots')).not.toContain('valid_from');
  });
});

describe('messages', () => {
  it('round-trips messages in chronological order', () => {
    const first = db.insertMessage({
      sessionId: 's1',
      role: 'user',
      content: 'hello',
      createdAt: '2025-11-03T09:00:00.000Z',
    });
    const second = db.insertMessage({
      sessionId: 's1',
      role: 'assistant',
      content: 'hi',
      createdAt: '2025-11-03T09:00:01.000Z',
    });

    expect(db.listMessagesBySession('s1')).toEqual([first, second]);
  });

  it('filters by day, inclusive on both ends', () => {
    for (const [day, content] of [
      ['2025-11-01', 'first'],
      ['2025-11-03', 'middle'],
      ['2025-11-05', 'last'],
    ] as const) {
      db.insertMessage({
        sessionId: 's1',
        role: 'user',
        content,
        createdAt: `${day}T12:00:00.000Z`,
      });
    }

    const hits = db.listMessagesByTimeRange('2025-11-03', '2025-11-03');
    expect(hits.map((message) => message.content)).toEqual(['middle']);
  });

  it('enforces foreign keys', () => {
    expect(() =>
      db.insertMessage({ sessionId: 'missing', role: 'user', content: 'orphan' }),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('finds messages by keyword even outside the time window', () => {
    db.insertMessage({
      sessionId: 's1',
      role: 'user',
      content: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team.',
      createdAt: '2025-10-20T09:00:00.000Z',
    });
    db.insertMessage({
      sessionId: 's1',
      role: 'user',
      content: 'Unrelated note about the office plants.',
      createdAt: '2025-11-18T09:00:00.000Z',
    });

    const hits = db.searchMessages(['crm', 'shortlisted']);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain('CRM tools');
  });

  it('ignores punctuation and empty keyword lists', () => {
    expect(db.searchMessages([])).toEqual([]);
    expect(db.searchMessages(['   '])).toEqual([]);
    expect(() => db.searchMessages(['crm; DROP TABLE messages;'])).not.toThrow();
  });
});

describe('snapshots', () => {
  it('round-trips structured claims and sources', () => {
    const message = db.insertMessage({
      sessionId: 's1',
      role: 'assistant',
      content: 'I compared five CRM tools.',
    });

    const snapshot = db.insertSnapshot({
      messageId: message.id,
      label: 'CRM shortlist (5 tools)',
      entities: ['ToolA', 'ToolB'],
      claims: [
        {
          subject: 'ToolA',
          attribute: 'pricing',
          value: '$12/user/month',
          as_of: '2025-11-17',
          source_ids: [0],
          confidence: 0.8,
        },
      ],
      sources: [
        {
          url: 'https://example.com/pricing',
          title: 'ToolA pricing',
          published_date: '2025-11-17',
          retrieved_at: '2025-11-18T10:00:00.000Z',
          snippet: 'Starter plan $12 per user per month.',
          content_hash: 'sha256:abc',
        },
      ],
    });

    const loaded = db.getSnapshot(snapshot.id);
    expect(loaded).toEqual(snapshot);
    expect(loaded?.claims[0]?.attribute).toBe('pricing');
    expect(loaded?.sources[0]?.content_hash).toBe('sha256:abc');
    expect(loaded?.topicKey).toBe('toola|toolb');
  });

  it('chains snapshots on the same topic', () => {
    const first = db.insertMessage({
      sessionId: 's1',
      role: 'assistant',
      content: 'Postgres hosting comparison',
    });
    const second = db.insertMessage({
      sessionId: 's1',
      role: 'assistant',
      content: 'Postgres pricing re-check',
    });

    const older = db.insertSnapshot({
      messageId: first.id,
      label: 'Postgres hosting',
      entities: ['Supabase', 'Neon'],
      claims: [],
      sources: [],
      observedAt: '2025-11-11T10:00:00.000Z',
    });
    const newer = db.insertSnapshot({
      messageId: second.id,
      label: 'Postgres hosting, one week later',
      entities: ['Neon', 'Supabase'],
      claims: [],
      sources: [],
      observedAt: '2025-11-18T10:00:00.000Z',
      supersedesId: older.id,
    });

    expect(newer.topicKey).toBe(older.topicKey);
    expect(db.listSnapshotsByTopic(older.topicKey).map((s) => s.id)).toEqual([
      older.id,
      newer.id,
    ]);
    expect(
      db.findSnapshotsByTimeRange('2025-11-11', '2025-11-11').map((s) => s.id),
    ).toEqual([older.id]);
  });

  it('rejects malformed claims before writing', () => {
    const message = db.insertMessage({
      sessionId: 's1',
      role: 'assistant',
      content: 'bad',
    });

    expect(() =>
      db.insertSnapshot({
        messageId: message.id,
        label: 'bad',
        entities: [],
        // @ts-expect-error deliberately invalid claim shape
        claims: [{ subject: 'x' }],
        sources: [],
      }),
    ).toThrow();
  });
});

describe('topic keys', () => {
  it('are stable when the model renames the label', () => {
    expect(deriveTopicKey('CRM shortlist (5 tools)', ['ToolA', 'ToolB'])).toBe(
      deriveTopicKey('The CRM tools we discussed', ['ToolB', 'ToolA']),
    );
  });

  it('fall back to the label when there are no entities', () => {
    expect(deriveTopicKey('Postgres hosting', [])).toBe('postgres-hosting');
  });
});
