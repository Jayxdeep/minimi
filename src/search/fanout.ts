import type { SearchGroup, SearchPlan, SearchProvider } from './types';

/** Fan-out is capped in code, independently of what the planner proposes. */
export const MAX_FANOUT = 6;

/**
 * Execute every planned query concurrently.
 *
 * One bad query must not cost the turn: failures become an empty group, are
 * logged, and the rest of the batch still reaches the synthesizer. This is the
 * only place in the pipeline where partial success is preferable to failure.
 */
export async function executeSearchPlan(
  plan: SearchPlan,
  provider: SearchProvider,
): Promise<SearchGroup[]> {
  const queries = plan.slice(0, MAX_FANOUT);
  if (queries.length === 0) return [];

  // Wrapping in an async arrow also converts a synchronous throw from a
  // provider implementation into a rejected promise.
  const settled = await Promise.allSettled(
    queries.map(async (entry) =>
      provider.search(entry.query, {
        mode: entry.mode,
        ...(entry.since ? { since: entry.since } : {}),
      }),
    ),
  );

  const groups: SearchGroup[] = [];

  for (let index = 0; index < queries.length; index += 1) {
    const entry = queries[index];
    const outcome = settled[index];
    if (!entry || !outcome) continue;

    if (outcome.status === 'fulfilled') {
      groups.push({ query: entry.query, results: outcome.value });
      continue;
    }

    const detail =
      outcome.reason instanceof Error
        ? outcome.reason.message
        : String(outcome.reason);
    console.error(`[search] "${entry.query}" failed: ${detail}`);
    groups.push({ query: entry.query, results: [] });
  }

  return groups;
}
