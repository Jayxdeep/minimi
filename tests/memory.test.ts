import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db';
import {
  buildMemoryIndex,
  condense,
  formatMemoryIndex,
  memorySnapshotIds,
} from '../src/memory';

const NOW = new Date('2026-11-18T12:00:00.000Z');

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
  db.migrate();
  db.upsertSession('s1');
});

afterEach(() => {
  db.close();
});

function message(content: string, createdAt: string) {
  return db.insertMessage({ sessionId: 's1', role: 'user', content, createdAt });
}

describe('buildMemoryIndex', () => {
  it('keeps only the recent window, oldest first', () => {
    message('ancient history', '2026-09-01T09:00:00.000Z');
    message('last week', '2026-11-11T09:00:00.000Z');
    message('yesterday', '2026-11-17T09:00:00.000Z');

    const entries = buildMemoryIndex(db, NOW);

    expect(entries.map((entry) => entry.kind === 'episode' && entry.text)).toEqual([
      'last week',
      'yesterday',
    ]);
  });

  it('includes snapshots with their claim subjects', () => {
    const source = message('Supabase Pro is $25', '2026-11-17T09:00:00.000Z');

    db.insertSnapshot({
      messageId: source.id,
      label: 'Postgres hosting',
      entities: ['Supabase', 'Neon'],
      claims: [
        {
          subject: 'Supabase',
          attribute: 'pricing',
          value: '$25/mo',
          as_of: '2026-11-10',
          source_ids: [0],
          confidence: 0.8,
        },
        {
          subject: 'Supabase',
          attribute: 'plan_tier',
          value: 'Pro',
          as_of: null,
          source_ids: [0],
          confidence: 0.6,
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

    const entries = buildMemoryIndex(db, NOW);
    const snapshot = entries.find((entry) => entry.kind === 'snapshot');

    expect(snapshot).toBeDefined();
    if (snapshot?.kind !== 'snapshot') throw new Error('expected a snapshot entry');

    expect(snapshot.entities).toEqual(['Supabase', 'Neon']);
    expect(snapshot.claimSubjects).toEqual([
      'Supabase/pricing',
      'Supabase/plan_tier',
    ]);
  });

  it('caps the total and keeps the newest entries', () => {
    for (let day = 1; day <= 6; day += 1) {
      message(`day ${day}`, `2026-11-1${day}T09:00:00.000Z`);
    }

    const entries = buildMemoryIndex(db, NOW, { maxEntries: 2 });

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.kind === 'episode' && entry.text)).toEqual([
      'day 5',
      'day 6',
    ]);
  });

  it('includes no entries for an empty database', () => {
    expect(buildMemoryIndex(db, NOW)).toEqual([]);
    expect(formatMemoryIndex([])).toContain('no stored memories');
  });
});

describe('formatMemoryIndex', () => {
  it('is one line per entry and includes snapshot ids verbatim', () => {
    const source = message('multi\nline   message', '2026-11-17T09:00:00.000Z');
    const snapshot = db.insertSnapshot({
      messageId: source.id,
      label: 'Topic',
      entities: ['Thing'],
      claims: [],
      sources: [],
      observedAt: '2026-11-17T10:00:00.000Z',
    });

    const text = formatMemoryIndex(buildMemoryIndex(db, NOW));
    const lines = text.split('\n');

    expect(lines).toHaveLength(2);
    expect(text).toContain(snapshot.id);
    expect(text).toContain('multi line message');
  });

  it('exposes snapshot ids as a set', () => {
    const entries = buildMemoryIndex(db, NOW);
    expect(memorySnapshotIds(entries).size).toBe(0);
  });
});

describe('condense', () => {
  it('flattens whitespace and truncates', () => {
    expect(condense('a\n b   c', 100)).toBe('a b c');
    expect(condense('abcdef', 4)).toBe('abc…');
  });
});
