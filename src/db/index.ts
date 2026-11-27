import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Sqlite from 'better-sqlite3';
import {
  ClaimSchema,
  SourceSchema,
  type Claim,
  type ClaimInput,
  type Message,
  type Role,
  type Session,
  type Snapshot,
  type Source,
  type SourceInput,
} from '../types';

type SqliteDb = InstanceType<typeof Sqlite>;

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/* -------------------------------------------------------------------------- */
/* Row shapes (SQL columns are aliased to camelCase)                          */
/* -------------------------------------------------------------------------- */

interface SessionRow {
  id: string;
  startedAt: string;
  userTz: string;
}

interface MessageRow {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  createdAt: string;
}

interface SnapshotRow {
  id: string;
  messageId: string;
  label: string;
  topicKey: string;
  entitiesJson: string;
  claimsJson: string;
  sourcesJson: string;
  observedAt: string;
  supersedesId: string | null;
}

const SESSION_COLUMNS = 'id, started_at AS startedAt, user_tz AS userTz';
const MESSAGE_COLUMNS =
  'id, session_id AS sessionId, role, content, created_at AS createdAt';
const MESSAGE_COLUMNS_ALIASED =
  'm.id, m.session_id AS sessionId, m.role, m.content, m.created_at AS createdAt';
const SNAPSHOT_COLUMNS = `id, message_id AS messageId, label, topic_key AS topicKey,
  entities_json AS entitiesJson, claims_json AS claimsJson, sources_json AS sourcesJson,
  observed_at AS observedAt, supersedes_id AS supersedesId`;

/* -------------------------------------------------------------------------- */
/* Time helpers                                                                */
/* -------------------------------------------------------------------------- */

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Expand a range bound. A bare `YYYY-MM-DD` covers the whole UTC day; a full
 * timestamp is normalised to UTC so it compares lexicographically against
 * everything we store.
 */
export function expandBound(value: string, edge: 'start' | 'end'): string {
  if (DATE_ONLY.test(value)) {
    return `${value}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp: ${JSON.stringify(value)}`);
  }
  return parsed.toISOString();
}

export function expandRange(start: string, end: string): [string, string] {
  const lo = expandBound(start, 'start');
  const hi = expandBound(end, 'end');
  if (lo > hi) {
    throw new Error(`Invalid range: start ${lo} is after end ${hi}`);
  }
  return [lo, hi];
}

/* -------------------------------------------------------------------------- */
/* Topic keys                                                                  */
/* -------------------------------------------------------------------------- */

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Entities are the stable part of a topic. Labels are model-written and drift
 * between turns ("CRM shortlist (5 tools)" vs "CRM shortlist"), so we derive
 * the key from the sorted entity set and fall back to the label.
 */
export function deriveTopicKey(label: string, entities: readonly string[]): string {
  const fromEntities = entities
    .map(slug)
    .filter((entry) => entry.length > 0)
    .sort()
    .join('|');

  return (fromEntities || slug(label) || 'untitled').slice(0, 200);
}

/* -------------------------------------------------------------------------- */
/* Public interface                                                            */
/* -------------------------------------------------------------------------- */

export interface InsertMessageInput {
  sessionId: string;
  role: Role;
  content: string;
  createdAt?: string;
  id?: string;
}

export interface InsertSnapshotInput {
  messageId: string;
  label: string;
  topicKey?: string;
  entities: string[];
  claims: ClaimInput[];
  sources: SourceInput[];
  observedAt?: string;
  supersedesId?: string | null;
  id?: string;
}

export interface PersistAnswerInput {
  sessionId: string;
  content: string;
  createdAt?: string;
  /** Absent/null means the answer made no citable claims. */
  snapshot?: Omit<InsertSnapshotInput, 'messageId'> | null;
}

export interface PersistAnswerResult {
  message: Message;
  snapshot: Snapshot | null;
}

export interface KeywordSearchOptions {
  start?: string;
  end?: string;
  limit?: number;
}

export interface Db {
  readonly raw: SqliteDb;
  migrate(): void;
  close(): void;

  upsertSession(id: string, userTz?: string, startedAt?: string): Session;
  getSession(id: string): Session | undefined;

  insertMessage(input: InsertMessageInput): Message;
  listMessagesBySession(sessionId: string): Message[];
  listMessagesByTimeRange(start: string, end: string): Message[];
  /** Global, newest-first selection then returned oldest-first for prompt order. */
  listRecentMessages(sinceIso: string, limit: number): Message[];
  searchMessages(keywords: readonly string[], options?: KeywordSearchOptions): Message[];

  insertSnapshot(input: InsertSnapshotInput): Snapshot;
  /**
   * Persist the assistant episode and its observation in one IMMEDIATE
   * transaction: a turn is remembered with evidence, or not at all.
   */
  persistAnswer(input: PersistAnswerInput): PersistAnswerResult;
  getSnapshot(id: string): Snapshot | undefined;
  listSnapshotsByTopic(topicKey: string): Snapshot[];
  findSnapshotsByTimeRange(start: string, end: string): Snapshot[];
  listRecentSnapshots(sinceIso: string, limit: number): Snapshot[];
  listSnapshotsByMessageIds(messageIds: readonly string[]): Snapshot[];
  searchSnapshots(keywords: readonly string[], limit?: number): Snapshot[];

  countMessages(sessionId?: string): number;
  ping(): boolean;
}

/* -------------------------------------------------------------------------- */
/* Implementation                                                              */
/* -------------------------------------------------------------------------- */

function mapMessage(row: MessageRow): Message {
  return { ...row };
}

function mapSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    messageId: row.messageId,
    label: row.label,
    topicKey: row.topicKey,
    entities: JSON.parse(row.entitiesJson) as string[],
    claims: ClaimSchema.array().parse(JSON.parse(row.claimsJson)) as Claim[],
    sources: SourceSchema.array().parse(JSON.parse(row.sourcesJson)) as Source[],
    observedAt: row.observedAt,
    supersedesId: row.supersedesId,
  };
}

/** Turn free text into a safe FTS5 prefix query ("crm* OR shortlist*"). */
function toFtsQuery(keywords: readonly string[]): string | null {
  const terms = new Set<string>();

  for (const keyword of keywords) {
    const pieces = keyword
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/);

    for (const piece of pieces) {
      if (piece.length > 1) terms.add(piece);
    }
  }

  if (terms.size === 0) return null;
  return [...terms].map((term) => `${term}*`).join(' OR ');
}

export function createDb(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const raw = new Sqlite(dbPath);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');

  const db: Db = {
    raw,

    migrate() {
      raw.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    },

    close() {
      if (raw.open) raw.close();
    },

    upsertSession(id, userTz = 'UTC', startedAt = nowIso()) {
      raw
        .prepare<[string, string, string], unknown>(
          `INSERT INTO sessions (id, started_at, user_tz) VALUES (?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(id, startedAt, userTz);

      const session = db.getSession(id);
      if (!session) throw new Error(`Failed to upsert session ${id}`);
      return session;
    },

    getSession(id) {
      const row = raw
        .prepare<[string], SessionRow>(
          `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`,
        )
        .get(id);
      return row ? { ...row } : undefined;
    },

    insertMessage({ sessionId, role, content, createdAt = nowIso(), id = randomUUID() }) {
      raw
        .prepare<[string, string, string, string, string], unknown>(
          `INSERT INTO messages (id, session_id, role, content, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, sessionId, role, content, createdAt);

      return { id, sessionId, role, content, createdAt };
    },

    listMessagesBySession(sessionId) {
      return raw
        .prepare<[string], MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM messages
           WHERE session_id = ?
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(sessionId)
        .map(mapMessage);
    },

    listMessagesByTimeRange(start, end) {
      const [lo, hi] = expandRange(start, end);
      return raw
        .prepare<[string, string], MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM messages
           WHERE created_at BETWEEN ? AND ?
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(lo, hi)
        .map(mapMessage);
    },

    listRecentMessages(sinceIso, limit) {
      return raw
        .prepare<[string, number], MessageRow>(
          `SELECT ${MESSAGE_COLUMNS} FROM messages
           WHERE created_at >= ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?`,
        )
        .all(sinceIso, limit)
        .reverse()
        .map(mapMessage);
    },

    searchMessages(keywords, options = {}) {
      const match = toFtsQuery(keywords);
      if (!match) return [];

      const params: unknown[] = [match];
      let where = 'messages_fts MATCH ?';

      if (options.start !== undefined && options.end !== undefined) {
        const [lo, hi] = expandRange(options.start, options.end);
        where += ' AND m.created_at BETWEEN ? AND ?';
        params.push(lo, hi);
      }

      params.push(options.limit ?? 20);

      return raw
        .prepare<unknown[], MessageRow>(
          `SELECT ${MESSAGE_COLUMNS_ALIASED}
           FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
           WHERE ${where}
           ORDER BY bm25(messages_fts) ASC, m.created_at DESC
           LIMIT ?`,
        )
        .all(...params)
        .map(mapMessage);
    },

    insertSnapshot(input) {
      const claims = ClaimSchema.array().parse(input.claims) as Claim[];
      const sources = SourceSchema.array().parse(input.sources) as Source[];
      const id = input.id ?? randomUUID();
      const observedAt = input.observedAt ?? nowIso();
      const topicKey =
        input.topicKey ?? deriveTopicKey(input.label, input.entities);
      const supersedesId = input.supersedesId ?? null;

      raw
        .prepare<
          [string, string, string, string, string, string, string, string, string | null],
          unknown
        >(
          `INSERT INTO snapshots
             (id, message_id, label, topic_key, entities_json, claims_json,
              sources_json, observed_at, supersedes_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.messageId,
          input.label,
          topicKey,
          JSON.stringify(input.entities),
          JSON.stringify(claims),
          JSON.stringify(sources),
          observedAt,
          supersedesId,
        );

      const snapshot = db.getSnapshot(id);
      if (!snapshot) throw new Error(`Failed to insert snapshot ${id}`);
      return snapshot;
    },

    persistAnswer(input) {
      // BEGIN IMMEDIATE: the answer and its snapshot commit together.
      const write = raw.transaction((data: PersistAnswerInput) => {
        const message = db.insertMessage({
          sessionId: data.sessionId,
          role: 'assistant',
          content: data.content,
          ...(data.createdAt ? { createdAt: data.createdAt } : {}),
        });

        const snapshot = data.snapshot
          ? db.insertSnapshot({ ...data.snapshot, messageId: message.id })
          : null;

        return { message, snapshot };
      });

      return write.immediate(input);
    },

    getSnapshot(id) {
      const row = raw
        .prepare<[string], SnapshotRow>(
          `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE id = ?`,
        )
        .get(id);
      return row ? mapSnapshot(row) : undefined;
    },

    listSnapshotsByTopic(topicKey) {
      return raw
        .prepare<[string], SnapshotRow>(
          `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots
           WHERE topic_key = ?
           ORDER BY observed_at ASC, rowid ASC`,
        )
        .all(topicKey)
        .map(mapSnapshot);
    },

    findSnapshotsByTimeRange(start, end) {
      const [lo, hi] = expandRange(start, end);
      return raw
        .prepare<[string, string], SnapshotRow>(
          `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots
           WHERE observed_at BETWEEN ? AND ?
           ORDER BY observed_at ASC, rowid ASC`,
        )
        .all(lo, hi)
        .map(mapSnapshot);
    },

    listRecentSnapshots(sinceIso, limit) {
      return raw
        .prepare<[string, number], SnapshotRow>(
          `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots
           WHERE observed_at >= ?
           ORDER BY observed_at DESC, rowid DESC
           LIMIT ?`,
        )
        .all(sinceIso, limit)
        .reverse()
        .map(mapSnapshot);
    },

    listSnapshotsByMessageIds(messageIds) {
      const ids = messageIds.slice(0, 500);
      if (ids.length === 0) return [];

      const placeholders = ids.map(() => '?').join(',');
      return raw
        .prepare<unknown[], SnapshotRow>(
          `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots
           WHERE message_id IN (${placeholders})
           ORDER BY observed_at ASC, rowid ASC`,
        )
        .all(...ids)
        .map(mapSnapshot);
    },

    searchSnapshots(keywords, limit = 8) {
      const terms = keywords
        .map((keyword) =>
          keyword
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim(),
        )
        .filter((term) => term.length > 1)
        .slice(0, 8);

      if (terms.length === 0) return [];

      const clause =
        '(lower(label) LIKE ? OR topic_key LIKE ? OR lower(entities_json) LIKE ?)';
      const params: unknown[] = [];

      for (const term of terms) {
        const pattern = `%${term}%`;
        params.push(pattern, pattern, pattern);
      }
      params.push(limit);

      return raw
        .prepare<unknown[], SnapshotRow>(
          `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots
           WHERE ${terms.map(() => clause).join(' OR ')}
           ORDER BY observed_at DESC, rowid DESC
           LIMIT ?`,
        )
        .all(...params)
        .reverse()
        .map(mapSnapshot);
    },

    countMessages(sessionId) {
      const row = sessionId
        ? raw
            .prepare<[string], { count: number }>(
              'SELECT COUNT(*) AS count FROM messages WHERE session_id = ?',
            )
            .get(sessionId)
        : raw
            .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM messages')
            .get();

      return row?.count ?? 0;
    },

    ping() {
      try {
        raw.prepare('SELECT 1 AS ok').get();
        return true;
      } catch {
        return false;
      }
    },
  };

  return db;
}
