import type { SearchProvider, SearchResult } from './types';

/**
 * Placeholder for a second provider. The interface is the point: swapping or
 * A/B testing search is a constructor change, not a route rewrite.
 */
export class ExaProvider implements SearchProvider {
  async search(): Promise<SearchResult[]> {
    return [];
  }
}
