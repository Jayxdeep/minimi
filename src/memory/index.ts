import type { Db } from '../db';
import type { Role } from '../types';

/**
 * A compact, deterministic view of recent memory, loaded BEFORE the planner.
 *
 * This is the ordering fix that makes "is your answer still correct today?"
 * answerable: the planner can only reference a snapshot id it has been shown.
 * It is one indexed SQL read, not a third model call.
 */

export type MemoryEntry =
  | {
      kind: 'episode';
      at: string;
      sessionId: string;
      role: Role;
      text: string;
    }
  | {
      kind: 'snapshot';
      at: string;
      id: string;
      label: string;
      entities: string[];
      claimSubjects: string[];
    };

export interface MemoryIndexOptions {
  /** How far back to look. */
  days?: number;
  maxEpisodes?: number;
  maxSnapshots?: number;
  /** Total line cap after merging episodes and snapshots. */
  maxEntries?: number;
  maxCharsPerEpisode?: number;
}

const DEFAULTS: Required<MemoryIndexOptions> = {
  days: 30,
  maxEpisodes: 24,
  maxSnapshots: 12,
  maxEntries: 36,
  maxCharsPerEpisode: 240,
};

export function condense(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}

export function buildMemoryIndex(
  db: Db,
  now: Date,
  options: MemoryIndexOptions = {},
): MemoryEntry[] {
  const settings = { ...DEFAULTS, ...options };
  const since = new Date(
    now.getTime() - settings.days * 24 * 60 * 60 * 1000,
  ).toISOString();

  const episodes: MemoryEntry[] = db
    .listRecentMessages(since, settings.maxEpisodes)
    .map((message) => ({
      kind: 'episode' as const,
      at: message.createdAt,
      sessionId: message.sessionId,
      role: message.role,
      text: condense(message.content, settings.maxCharsPerEpisode),
    }));

  const snapshots: MemoryEntry[] = db
    .listRecentSnapshots(since, settings.maxSnapshots)
    .map((snapshot) => ({
      kind: 'snapshot' as const,
      at: snapshot.observedAt,
      id: snapshot.id,
      label: condense(snapshot.label, 120),
      entities: snapshot.entities.slice(0, 10),
      claimSubjects: [
        ...new Set(
          snapshot.claims.map(
            (claim) => `${claim.subject}/${claim.attribute}`,
          ),
        ),
      ].slice(0, 12),
    }));

  return [...episodes, ...snapshots]
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-settings.maxEntries);
}

export function formatMemoryIndex(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return '(no stored memories in the window)';

  return entries
    .map((entry) => {
      if (entry.kind === 'episode') {
        return `${entry.at} episode ${entry.role} · ${JSON.stringify(entry.text)}`;
      }

      const entities = entry.entities.join(',') || '-';
      const claims = entry.claimSubjects.join(',') || '-';
      return `${entry.at} snapshot ${entry.id} · ${JSON.stringify(entry.label)} · entities=${entities} · claims=${claims}`;
    })
    .join('\n');
}

export function memorySnapshotIds(entries: readonly MemoryEntry[]): Set<string> {
  return new Set(
    entries.flatMap((entry) => (entry.kind === 'snapshot' ? [entry.id] : [])),
  );
}
