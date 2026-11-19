-- ---------------------------------------------------------------------------
-- Phase 0 schema.
--
-- Conventions that the whole app depends on:
--   * Every timestamp is a UTC ISO-8601 string ending in "Z"
--     (new Date().toISOString()), so lexicographic comparison == chronological.
--   * messages are episodes: append-only, never rewritten.
--   * snapshots are observations, not truths. observed_at is when we looked.
--   * memory is global across sessions; session_id is an episode boundary only.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  user_tz    TEXT NOT NULL DEFAULT 'UTC'
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Session-local reads.
CREATE INDEX IF NOT EXISTS idx_messages_session_time
  ON messages(session_id, created_at);
-- Cross-session temporal recall ("what did I ask on 3 November").
CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON messages(created_at);

CREATE TABLE IF NOT EXISTS snapshots (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  topic_key     TEXT NOT NULL,
  entities_json TEXT NOT NULL DEFAULT '[]',
  claims_json   TEXT NOT NULL DEFAULT '[]',
  sources_json  TEXT NOT NULL DEFAULT '[]',
  observed_at   TEXT NOT NULL,
  supersedes_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_message
  ON snapshots(message_id);
-- Find the chain of observations for a topic without embeddings.
CREATE INDEX IF NOT EXISTS idx_snapshots_topic_time
  ON snapshots(topic_key, observed_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_observed_at
  ON snapshots(observed_at);

-- ---------------------------------------------------------------------------
-- Keyword recall. Time windows cannot find "the shortlist we made last week"
-- when it falls outside the window; FTS5 + planner keywords can.
-- External-content table: no duplicate copy of message bodies.
-- ---------------------------------------------------------------------------

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content = 'messages',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
