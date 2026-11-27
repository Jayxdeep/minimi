import type { Db } from '../db';
import { condense } from '../memory';
import type { Message, PlannerOutput, Snapshot } from '../types';

/**
 * Phase 4 recall.
 *
 * The planner decides *what* to look for; this module decides exactly *what to
 * load*, deterministically, from SQL:
 *
 *   window        — episodes and snapshots inside the resolved time range
 *   keywords      — FTS hits for episodes, LIKE hits for snapshots (bridges a
 *                   wrong "on Monday" window when the shortlist was Thursday)
 *   verify ids    — snapshots the planner explicitly asked to re-check
 *   linked        — snapshots attached to any recalled episode
 *
 * No embeddings, no relevance model, no third LLM call. The synthesizer then
 * sees full claims and sources, not just headers, which is what makes change
 * detection possible.
 */

export interface Recall {
  episodes: Message[];
  snapshots: Snapshot[];
}

export interface RecallOptions {
  /** The turn's own user message must not count as memory. */
  excludeMessageId?: string;
  maxEpisodes?: number;
  maxSnapshots?: number;
}

export function recallMemory(
  db: Db,
  plan: PlannerOutput,
  options: RecallOptions = {},
): Recall {
  const maxEpisodes = options.maxEpisodes ?? 20;
  const maxSnapshots = options.maxSnapshots ?? 8;

  const episodes = new Map<string, Message>();
  const snapshots = new Map<string, Snapshot>();
  const priority = new Set<string>();

  const window = plan.memory.window;
  if (window) {
    for (const message of db.listMessagesByTimeRange(window[0], window[1])) {
      episodes.set(message.id, message);
    }
    for (const snapshot of db.findSnapshotsByTimeRange(window[0], window[1])) {
      snapshots.set(snapshot.id, snapshot);
    }
  }

  if (plan.memory.keywords.length > 0) {
    for (const message of db.searchMessages(plan.memory.keywords, {
      limit: maxEpisodes,
    })) {
      episodes.set(message.id, message);
    }
    for (const snapshot of db.searchSnapshots(
      plan.memory.keywords,
      maxSnapshots,
    )) {
      snapshots.set(snapshot.id, snapshot);
    }
  }

  for (const id of plan.verify_snapshot_ids) {
    const snapshot = db.getSnapshot(id);
    if (snapshot) {
      snapshots.set(snapshot.id, snapshot);
      priority.add(snapshot.id);
    }
  }

  if (episodes.size > 0) {
    for (const snapshot of db.listSnapshotsByMessageIds([...episodes.keys()])) {
      snapshots.set(snapshot.id, snapshot);
    }
  }

  if (options.excludeMessageId) {
    episodes.delete(options.excludeMessageId);
  }

  const recalledEpisodes = [...episodes.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-maxEpisodes);

  let recalledSnapshots = [...snapshots.values()].sort((a, b) =>
    a.observedAt.localeCompare(b.observedAt),
  );

  if (recalledSnapshots.length > maxSnapshots) {
    // Explicit re-verification always wins over "recent by accident".
    const mustKeep = recalledSnapshots.filter((snapshot) =>
      priority.has(snapshot.id),
    );
    const rest = recalledSnapshots.filter(
      (snapshot) => !priority.has(snapshot.id),
    );
    const room = Math.max(0, maxSnapshots - mustKeep.length);
    recalledSnapshots = [...mustKeep, ...rest.slice(-room)].sort((a, b) =>
      a.observedAt.localeCompare(b.observedAt),
    );
  }

  return { episodes: recalledEpisodes, snapshots: recalledSnapshots };
}

/** Render recalled memory for the synthesizer prompt, values included. */
export function formatRecall(recall: Recall): string {
  if (recall.episodes.length === 0 && recall.snapshots.length === 0) {
    return '(no stored memories matched this question)';
  }

  const lines: string[] = [];

  if (recall.episodes.length > 0) {
    lines.push('EPISODES (oldest first):');
    for (const message of recall.episodes) {
      lines.push(
        `[${message.createdAt}] ${message.role}: ${condense(message.content, 500)}`,
      );
    }
  }

  if (recall.snapshots.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      'SNAPSHOTS (observed = when the agent looked; as_of = the source date):',
    );

    for (const snapshot of recall.snapshots) {
      const chain = snapshot.supersedesId
        ? ` | supersedes ${snapshot.supersedesId}`
        : '';
      lines.push(
        `snapshot ${snapshot.id} | ${snapshot.label} | observed ${snapshot.observedAt}${chain}`,
      );

      if (snapshot.entities.length > 0) {
        lines.push(`  entities: ${snapshot.entities.join(', ')}`);
      }

      for (const claim of snapshot.claims) {
        const urls = claim.source_ids
          .map((index) => snapshot.sources[index]?.url)
          .filter((url): url is string => typeof url === 'string');
        const citation = urls.length > 0 ? ` — ${urls.join(', ')}` : '';
        lines.push(
          `  claim: ${claim.subject} / ${claim.attribute} = ${JSON.stringify(claim.value)} (as_of ${claim.as_of ?? 'unknown'}, confidence ${claim.confidence})${citation}`,
        );
      }

      for (const source of snapshot.sources) {
        const published = source.published_date
          ? ` (published ${source.published_date})`
          : '';
        lines.push(`  source: ${source.url}${published}`);
      }
    }
  }

  return lines.join('\n');
}

export function recallSnapshotIds(recall: Recall): string[] {
  return recall.snapshots.map((snapshot) => snapshot.id);
}
