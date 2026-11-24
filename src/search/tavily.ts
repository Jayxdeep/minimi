import { DATE_ONLY } from '../time';
import type {
  SearchOptions,
  SearchProvider,
  SearchResult,
} from './types';

/**
 * Tavily, via its REST API. No SDK: one POST, one mapping.
 *
 * Auth uses the bearer header rather than putting the key in the JSON body, so
 * it never appears in a request log or an error dump.
 */

export interface TavilyProviderOptions {
  apiKey?: string | undefined;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  maxResults?: Partial<Record<SearchOptions['mode'], number>>;
}

interface TavilyItem {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  published_date?: unknown;
}

interface TavilyResponse {
  results?: unknown;
}

const DEFAULT_MAX_RESULTS: Record<SearchOptions['mode'], number> = {
  quick: 5,
  deep: 8,
  news: 5,
};

/** Offline fallback. Honest about why there is nothing real to show. */
export const STUB_RESULT: SearchResult = {
  title: 'Stub',
  url: 'https://stub.com',
  snippet: 'Tavily key missing',
};

function toResult(item: TavilyItem): SearchResult | null {
  if (typeof item.url !== 'string' || item.url.length === 0) return null;

  const result: SearchResult = {
    url: item.url,
    title: typeof item.title === 'string' && item.title.length > 0 ? item.title : item.url,
    snippet: typeof item.content === 'string' ? item.content : '',
  };

  if (typeof item.published_date === 'string' && item.published_date.length > 0) {
    result.publishedDate = item.published_date;
  }

  return result;
}

export class TavilyProvider implements SearchProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxResults: Record<SearchOptions['mode'], number>;

  constructor(options: TavilyProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://api.tavily.com/search';
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxResults = { ...DEFAULT_MAX_RESULTS, ...options.maxResults };
  }

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    if (!this.apiKey) {
      // Tests and key-less demos still exercise the whole pipeline.
      return [{ ...STUB_RESULT }];
    }

    const body: Record<string, unknown> = {
      query,
      search_depth: opts.mode === 'deep' ? 'advanced' : 'basic',
      topic: opts.mode === 'news' ? 'news' : 'general',
      max_results: this.maxResults[opts.mode],
      include_answer: false,
      include_raw_content: false,
      // Date matters more to us than Tavily's default: without this, general
      // searches omit published_date entirely and change detection loses its
      // only real timestamp. News mode enables it automatically.
      include_published_date: true,
    };

    if (opts.since && DATE_ONLY.test(opts.since)) {
      body.start_date = opts.since;
    }

    const response = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Tavily returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as TavilyResponse;
    if (!Array.isArray(payload.results)) {
      throw new Error('Tavily response is missing a results array');
    }

    return (payload.results as TavilyItem[])
      .map(toResult)
      .filter((result): result is SearchResult => result !== null);
  }
}
