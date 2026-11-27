import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeSearchPlan, dedupeSearchGroups, MAX_FANOUT } from '../src/search/fanout';
import { STUB_RESULT, TavilyProvider } from '../src/search/tavily';
import type { SearchPlan, SearchProvider } from '../src/search/types';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TavilyProvider', () => {
  it('returns a stub when no API key is configured', async () => {
    const fetchImpl = vi.fn();
    const provider = new TavilyProvider({
      apiKey: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const results = await provider.search('anything', { mode: 'quick' });

    expect(results).toEqual([STUB_RESULT]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps mode, since and the response fields', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            title: 'Supabase Pricing',
            url: 'https://supabase.com/pricing',
            content: 'Pro is $25/mo',
            published_date: '2026-11-18',
          },
          { title: 'no url', content: 'dropped' },
        ],
      }),
    );

    const provider = new TavilyProvider({
      apiKey: 'tvly-test',
      baseUrl: 'https://api.tavily.test/search',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const results = await provider.search('supabase pricing', {
      mode: 'news',
      since: '2026-11-10',
    });

    expect(results).toEqual([
      {
        title: 'Supabase Pricing',
        url: 'https://supabase.com/pricing',
        snippet: 'Pro is $25/mo',
        publishedDate: '2026-11-18',
      },
    ]);

    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error('expected a fetch call');

    const [url, init] = call as unknown as [string, RequestInit];
    expect(url).toBe('https://api.tavily.test/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tvly-test',
    );

    expect(JSON.parse(String(init.body))).toMatchObject({
      query: 'supabase pricing',
      topic: 'news',
      search_depth: 'basic',
      max_results: 5,
      include_published_date: true,
      start_date: '2026-11-10',
    });
  });

  it('uses advanced depth for deep mode and omits a bad since', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
    const provider = new TavilyProvider({
      apiKey: 'tvly-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.search('compare postgres hosting', {
      mode: 'deep',
      since: 'last tuesday',
    });

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(call[1].body));

    expect(body).toMatchObject({
      topic: 'general',
      search_depth: 'advanced',
      max_results: 8,
    });
    expect(body.start_date).toBeUndefined();
  });

  it('throws on a non-2xx response', async () => {
    const provider = new TavilyProvider({
      apiKey: 'tvly-test',
      fetchImpl: (async () =>
        new Response('rate limited', { status: 429 })) as unknown as typeof fetch,
    });

    await expect(provider.search('q', { mode: 'quick' })).rejects.toThrow(
      /HTTP 429/,
    );
  });

  it('throws when the payload has no results array', async () => {
    const provider = new TavilyProvider({
      apiKey: 'tvly-test',
      fetchImpl: (async () =>
        jsonResponse({ answer: 'nope' })) as unknown as typeof fetch,
    });

    await expect(provider.search('q', { mode: 'quick' })).rejects.toThrow(
      /results array/,
    );
  });
});

describe('dedupeSearchGroups', () => {
  it('keeps the first occurrence of a URL and preserves order', () => {
    const groups = [
      {
        query: 'a',
        results: [
          { url: 'https://x.com/1', title: 'X1', snippet: '' },
          { url: 'https://x.com/2', title: 'X2', snippet: '' },
        ],
      },
      {
        query: 'b',
        results: [
          { url: 'https://x.com/2', title: 'X2 again', snippet: '' },
          { url: 'https://x.com/3', title: 'X3', snippet: '' },
        ],
      },
    ];

    const deduped = dedupeSearchGroups(groups);

    expect(deduped[0]?.results.map((result) => result.url)).toEqual([
      'https://x.com/1',
      'https://x.com/2',
    ]);
    expect(deduped[1]?.results.map((result) => result.url)).toEqual([
      'https://x.com/3',
    ]);
    expect(deduped[1]?.query).toBe('b');
  });

  it('is a no-op for a disjoint batch', () => {
    const groups = [
      { query: 'a', results: [{ url: 'https://a.com', title: 'A', snippet: '' }] },
    ];
    expect(dedupeSearchGroups(groups)).toEqual(groups);
  });
});

describe('executeSearchPlan', () => {
  it('returns empty for an empty plan without calling the provider', async () => {
    const search = vi.fn();
    const provider: SearchProvider = { search };

    await expect(executeSearchPlan([], provider)).resolves.toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('caps fan-out at six queries and preserves plan order', async () => {
    const seen: string[] = [];
    const provider: SearchProvider = {
      async search(query) {
        seen.push(query);
        return [{ url: `https://example.com/${query}`, title: query, snippet: '' }];
      },
    };

    const plan: SearchPlan = Array.from({ length: 8 }, (_, index) => ({
      query: `q${index + 1}`,
      mode: 'quick' as const,
    }));

    const groups = await executeSearchPlan(plan, provider);

    expect(seen).toHaveLength(MAX_FANOUT);
    expect(groups).toHaveLength(MAX_FANOUT);
    expect(groups.map((group) => group.query)).toEqual([
      'q1',
      'q2',
      'q3',
      'q4',
      'q5',
      'q6',
    ]);
  });

  it('keeps the batch alive when one query rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const provider: SearchProvider = {
      async search(query) {
        if (query === 'bad') throw new Error('provider exploded');
        return [{ url: `https://example.com/${query}`, title: query, snippet: 'ok' }];
      },
    };

    const groups = await executeSearchPlan(
      [
        { query: 'good', mode: 'quick' },
        { query: 'bad', mode: 'news' },
        { query: 'also-good', mode: 'deep' },
      ],
      provider,
    );

    expect(groups.map((group) => group.query)).toEqual([
      'good',
      'bad',
      'also-good',
    ]);
    expect(groups[0]?.results).toHaveLength(1);
    expect(groups[1]?.results).toEqual([]);
    expect(groups[2]?.results).toHaveLength(1);
  });

  it('contains a synchronous throw from a provider', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const provider: SearchProvider = {
      search() {
        throw new Error('sync boom');
      },
    };

    const groups = await executeSearchPlan([{ query: 'q', mode: 'quick' }], provider);

    expect(groups).toEqual([{ query: 'q', results: [] }]);
  });

  it('passes each query its own mode and since', async () => {
    const received: Array<{ query: string; mode: string; since?: string }> = [];
    const provider: SearchProvider = {
      async search(query, opts) {
        received.push({ query, mode: opts.mode, ...(opts.since ? { since: opts.since } : {}) });
        return [];
      },
    };

    await executeSearchPlan(
      [
        { query: 'a', mode: 'news', since: '2026-11-10' },
        { query: 'b', mode: 'deep' },
      ],
      provider,
    );

    expect(received).toEqual([
      { query: 'a', mode: 'news', since: '2026-11-10' },
      { query: 'b', mode: 'deep' },
    ]);
  });
});
