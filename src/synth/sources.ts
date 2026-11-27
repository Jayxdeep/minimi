import { createHash } from 'node:crypto';
import type { SearchGroup } from '../search/types';
import type { Claim, Source } from '../types';
import type { SynthesisTrailer } from './types';

/** A search result with its stable 1-based citation index. */
export interface FlatSource {
  index: number;
  url: string;
  title: string;
  snippet: string;
  publishedDate?: string;
}

const MAX_SNIPPET_CHARS = 300;

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Flatten grouped results in exactly the order the UI renders them, so a `[3]`
 * in the answer matches the third numbered result on screen.
 */
export function flattenSources(groups: readonly SearchGroup[]): FlatSource[] {
  const flat: FlatSource[] = [];

  for (const group of groups) {
    for (const result of group.results) {
      flat.push({
        index: flat.length + 1,
        url: result.url,
        title: result.title,
        snippet: truncate(result.snippet, MAX_SNIPPET_CHARS),
        ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
      });
    }
  }

  return flat;
}

export function contentHash(text: string): string {
  const normalised = text.replace(/\s+/g, ' ').trim();
  const digest = createHash('sha256').update(normalised).digest('hex');
  return `sha256:${digest.slice(0, 32)}`;
}

function normaliseAsOf(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

/**
 * Build the stored evidence for a snapshot.
 *
 * `claims[].source_ids` are 0-based positions in `sources`, not prompt indexes:
 * the source list is compacted to only what was used, so the two must be
 * remapped together. Without this, a claim citing prompt source [6] would point
 * past the end of a four-item sources array.
 */
export function buildEvidence(
  trailer: SynthesisTrailer,
  flat: readonly FlatSource[],
  retrievedAt: Date,
): { claims: Claim[]; sources: Source[] } {
  const valid = new Set(flat.map((source) => source.index));

  const drafts = trailer.claims
    .map((draft) => ({
      draft,
      flatIds: [...new Set(draft.source_ids.filter((id) => valid.has(id)))],
    }))
    .filter((entry) => entry.flatIds.length > 0);

  const used = new Set<number>(
    trailer.used_sources.filter((id) => valid.has(id)),
  );
  for (const entry of drafts) {
    for (const id of entry.flatIds) used.add(id);
  }

  const ordered = flat.filter((source) => used.has(source.index));
  const position = new Map<number, number>(
    ordered.map((source, index) => [source.index, index]),
  );

  const claims: Claim[] = [];

  for (const { draft, flatIds } of drafts) {
    const subject = draft.subject.trim().slice(0, 120);
    const attribute = draft.attribute.trim().toLowerCase().slice(0, 60);
    if (subject.length === 0 || attribute.length === 0) continue;

    const sourceIds = flatIds
      .map((id) => position.get(id))
      .filter((id): id is number => id !== undefined);
    if (sourceIds.length === 0) continue;

    claims.push({
      subject,
      attribute,
      value: draft.value.trim().slice(0, 500),
      as_of: normaliseAsOf(draft.as_of),
      source_ids: sourceIds,
      confidence: draft.confidence,
    });
  }

  const sources: Source[] = ordered.map((source) => ({
    url: source.url,
    title: source.title,
    published_date: source.publishedDate ?? null,
    retrieved_at: retrievedAt.toISOString(),
    snippet: source.snippet,
    content_hash: contentHash(source.snippet),
  }));

  return { claims, sources };
}

export function formatSourcesForPrompt(flat: readonly FlatSource[]): string {
  if (flat.length === 0) return '(no sources returned — the search plan found nothing)';

  return flat
    .map((source) => {
      const date = source.publishedDate ? `\n    Published: ${source.publishedDate}` : '';
      return `[${source.index}] ${source.title}\n    URL: ${source.url}${date}\n    ${source.snippet}`;
    })
    .join('\n\n');
}
