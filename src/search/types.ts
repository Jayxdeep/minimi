/**
 * The search seam. One provider, three modes, no agent framework.
 *
 * Results are what the synthesizer will read in Phase 3 and what the snapshot
 * will cite, so the shape stays close to the wire: no embeddings, no reranking.
 */

export type SearchMode = 'quick' | 'deep' | 'news';

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  publishedDate?: string;
}

export interface SearchOptions {
  mode: SearchMode;
  /** Inclusive lower bound, YYYY-MM-DD. */
  since?: string;
}

export interface SearchProvider {
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}

/** The subset of the planner output that fan-out needs. */
export interface SearchQuery {
  query: string;
  mode: SearchMode;
  since?: string;
}

export type SearchPlan = readonly SearchQuery[];

/** Results for one planned query, in plan order. */
export interface SearchGroup {
  query: string;
  results: SearchResult[];
}
