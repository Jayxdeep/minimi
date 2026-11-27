import { describe, expect, it } from 'vitest';
import { AnswerSplitter, looksLikePartialFence } from '../src/synth/fence';
import {
  createSynthesizer,
  parseTrailer,
  SynthesisError,
  type SynthesisContext,
} from '../src/synth';
import { SYNTH_SYSTEM_PROMPT } from '../src/synth/prompt';
import { contentHash, flattenSources } from '../src/synth/sources';
import type { Recall } from '../src/recall';
import type { SearchGroup } from '../src/search/types';
import type { PlannerOutput } from '../src/types';
import { FIXED_NOW, FakeLLMClient, synthesisText } from './helpers/fake-llm';

const GROUPS: SearchGroup[] = [
  {
    query: 'Supabase pricing',
    results: [
      {
        url: 'https://supabase.com/pricing',
        title: 'Supabase Pricing',
        snippet: 'Pro is $25/mo',
        publishedDate: '2026-11-17',
      },
      { url: 'https://example.com/a', title: 'A', snippet: 'alpha' },
    ],
  },
  {
    query: 'Neon pricing',
    results: [
      {
        url: 'https://neon.com/pricing',
        title: 'Neon Pricing',
        snippet: 'Scale is $69/mo',
      },
    ],
  },
];

const TRAILER = {
  label: 'Postgres hosting pricing',
  entities: ['Supabase', 'Neon'],
  claims: [
    {
      subject: 'Supabase',
      attribute: 'pricing',
      value: 'Pro is $25/mo',
      as_of: '2026-11-17',
      source_ids: [1],
      confidence: 0.8,
    },
    {
      subject: 'Neon',
      attribute: 'pricing',
      value: 'Scale is $69/mo',
      as_of: null,
      source_ids: [3],
      confidence: 0.7,
    },
  ],
  used_sources: [1, 3],
  supersedes_id: null,
};

const PLAN: PlannerOutput = {
  intent: 'change',
  now_iso: FIXED_NOW.toISOString(),
  temporal_refs: [],
  memory: { window: null, keywords: [] },
  search_plan: [],
  verify_snapshot_ids: [],
};

function context(overrides: Partial<SynthesisContext> = {}): SynthesisContext {
  return {
    message: 'has postgres hosting pricing changed?',
    now: FIXED_NOW,
    userTz: 'Europe/London',
    plan: PLAN,
    recall: { episodes: [], snapshots: [] },
    groups: GROUPS,
    ...overrides,
  };
}

const RECALL: Recall = {
  episodes: [
    {
      id: 'm-old',
      sessionId: 's1',
      role: 'user',
      content: 'Can you compare Supabase and Neon?',
      createdAt: '2026-11-03T09:00:00.000Z',
    },
  ],
  snapshots: [
    {
      id: 'snap_postgres',
      messageId: 'm-old',
      label: 'Postgres hosting pricing',
      topicKey: 'neon|supabase',
      entities: ['Supabase', 'Neon'],
      claims: [
        {
          subject: 'Supabase',
          attribute: 'pricing',
          value: 'Pro is $25/mo',
          as_of: '2026-11-02',
          source_ids: [0],
          confidence: 0.8,
        },
      ],
      sources: [
        {
          url: 'https://supabase.com/pricing',
          title: 'Pricing',
          published_date: '2026-11-02',
          retrieved_at: '2026-11-03T09:00:00.000Z',
          snippet: 'Pro $25',
          content_hash: 'sha256:abc',
        },
      ],
      observedAt: '2026-11-03T09:00:00.000Z',
      supersedesId: null,
    },
  ],
};

function run(client: FakeLLMClient, ctx: SynthesisContext = context()) {
  const tokens: string[] = [];
  const synthesizer = createSynthesizer(client);
  return synthesizer
    .run(ctx, (text) => tokens.push(text))
    .then((result) => ({ result, tokens, streamed: tokens.join('') }));
}

describe('looksLikePartialFence', () => {
  it('recognises prefixes but not other code fences', () => {
    expect(looksLikePartialFence('`')).toBe(true);
    expect(looksLikePartialFence('```j')).toBe(true);
    expect(looksLikePartialFence('```JSON')).toBe(true);
    expect(looksLikePartialFence('  ```js ')).toBe(true);
    expect(looksLikePartialFence('```sql')).toBe(false);
    expect(looksLikePartialFence('   ')).toBe(false);
    expect(looksLikePartialFence('')).toBe(false);
  });
});

describe('AnswerSplitter', () => {
  it('streams answer text and withholds the fenced trailer', () => {
    const splitter = new AnswerSplitter();
    const out = [
      splitter.push('Supabase Pro is $25/mo [1].'),
      splitter.push('\n\n```js'),
      splitter.push('on\n{"label":"x"}\n```\n'),
    ].join('');

    expect(out).toBe('Supabase Pro is $25/mo [1].\n\n');
    expect(out).not.toContain('```');

    const finished = splitter.finish();
    expect(finished.answer).toBe(out);
    expect(finished.trailerText).toBe('{"label":"x"}\n```\n');
  });

  it('does not treat a SQL code block as the trailer', () => {
    const splitter = new AnswerSplitter();
    const out = splitter.push('Example:\n```sql\nselect 1;\n```\n');
    const finished = splitter.finish();

    expect(out).toContain('```sql');
    expect(finished.trailerText).toBeNull();
  });

  it('emits a held partial fence when it turns out not to be one', () => {
    const splitter = new AnswerSplitter();
    const first = splitter.push('text\n```j');
    const second = splitter.push('avascript code');

    expect(first).toBe('text\n');
    expect(first + second).toBe('text\n```javascript code');
  });

  it('flushes a trailing partial fence as answer text at finish', () => {
    const splitter = new AnswerSplitter();
    splitter.push('done\n```');
    const finished = splitter.finish();

    expect(finished.remainder).toBe('```');
    expect(finished.answer).toBe('done\n```');
    expect(finished.trailerText).toBeNull();
  });
});

describe('parseTrailer', () => {
  it('tolerates trailing prose after the closing fence', () => {
    const trailer = parseTrailer('{"label":"x"}\n```\nignored prose');
    expect(trailer.label).toBe('x');
  });

  it('tolerates a missing closing fence', () => {
    const trailer = parseTrailer('{"label":"x"}');
    expect(trailer.label).toBe('x');
  });

  it('throws on invalid JSON or schema', () => {
    expect(() => parseTrailer('not json')).toThrow(SynthesisError);
    expect(() => parseTrailer('{"label":""}')).toThrow(SynthesisError);
  });
});

describe('flattenSources', () => {
  it('numbers results in render order', () => {
    const flat = flattenSources(GROUPS);
    expect(flat.map((source) => source.index)).toEqual([1, 2, 3]);
    expect(flat[2]?.url).toBe('https://neon.com/pricing');
  });

  it('hashes normalised snippet content deterministically', () => {
    expect(contentHash('a   b\nc')).toBe(contentHash('a b c'));
    expect(contentHash('a b c')).toMatch(/^sha256:[0-9a-f]{32}$/);
  });
});

describe('SYNTH_SYSTEM_PROMPT', () => {
  it('demands extraction from tables and version numbers', () => {
    expect(SYNTH_SYSTEM_PROMPT).toContain(
      'Carefully read ALL provided search snippets.',
    );
    expect(SYNTH_SYSTEM_PROMPT).toContain('markdown tables');
    expect(SYNTH_SYSTEM_PROMPT).toContain('extract it verbatim');
  });

  it('forbids web search for pasted text', () => {
    expect(SYNTH_SYSTEM_PROMPT).toContain('large block of text');
    expect(SYNTH_SYSTEM_PROMPT).toContain('do NOT search the web');
    expect(SYNTH_SYSTEM_PROMPT).toContain(
      'Base your answer entirely on the text they provided.',
    );
  });

  it('requires the three verdict labels', () => {
    expect(SYNTH_SYSTEM_PROMPT).toContain('**Changed**');
    expect(SYNTH_SYSTEM_PROMPT).toContain('**Unchanged**');
    expect(SYNTH_SYSTEM_PROMPT).toContain("**Couldn't verify**");
  });
});

describe('createSynthesizer', () => {
  it('returns the answer, maps citations to real URLs, and builds a snapshot', async () => {
    const client = new FakeLLMClient(
      [],
      [
        synthesisText(
          'Supabase Pro is $25/mo [1]. Neon Scale is $69/mo [3].',
          TRAILER,
        ),
      ],
    );

    const { result, streamed } = await run(client);

    expect(streamed).toContain('Supabase Pro is $25/mo [1].');
    expect(streamed).not.toContain('```json');
    expect(streamed).not.toContain('"label"');
    expect(result.answer).toBe(streamed);

    const snapshot = result.snapshot;
    expect(snapshot).not.toBeNull();
    if (!snapshot) throw new Error('expected a snapshot');

    expect(snapshot.label).toBe('Postgres hosting pricing');
    expect(snapshot.entities).toEqual(['Supabase', 'Neon']);
    expect(snapshot.claims).toHaveLength(2);
    // 0-based positions inside snapshot.sources, not prompt citation indexes.
    expect(snapshot.claims[0]?.source_ids).toEqual([0]);
    expect(snapshot.claims[1]?.source_ids).toEqual([1]);
    expect(snapshot.sources.map((source) => source.url)).toEqual([
      'https://supabase.com/pricing',
      'https://neon.com/pricing',
    ]);
    expect(snapshot.sources[0]?.published_date).toBe('2026-11-17');
    expect(snapshot.sources[0]?.retrieved_at).toBe(FIXED_NOW.toISOString());
    expect(snapshot.sources[0]?.content_hash).toMatch(/^sha256:/);
  });

  it('drops claims that cite no real source', async () => {
    const trailer = {
      ...TRAILER,
      claims: [
        { ...TRAILER.claims[0], source_ids: [99] },
        TRAILER.claims[1],
      ],
      used_sources: [99, 3],
    };

    const client = new FakeLLMClient(
      [],
      [synthesisText('Only Neon is verifiable [3].', trailer)],
    );

    const { result } = await run(client);
    const snapshot = result.snapshot;
    if (!snapshot) throw new Error('expected a snapshot');

    expect(snapshot.claims.map((claim) => claim.subject)).toEqual(['Neon']);
    expect(snapshot.claims[0]?.source_ids).toEqual([0]);
    expect(snapshot.sources.map((source) => source.url)).toEqual([
      'https://neon.com/pricing',
    ]);
  });

  it('remaps a claim cited late in the prompt to its compacted source position', async () => {
    // Prompt index 3 becomes position 0 because nothing cites 1 or 2 first.
    const trailer = {
      label: 'Neon pricing',
      entities: ['Neon'],
      claims: [
        {
          subject: 'Neon',
          attribute: 'pricing',
          value: 'Scale is $69/mo',
          as_of: null,
          source_ids: [3],
          confidence: 0.7,
        },
      ],
      used_sources: [3],
      supersedes_id: null,
    };

    const client = new FakeLLMClient([], [synthesisText('Neon is $69 [3].', trailer)]);
    const { result } = await run(client);

    expect(result.snapshot?.claims[0]?.source_ids).toEqual([0]);
    expect(result.snapshot?.sources).toHaveLength(1);
  });

  it('omits the snapshot when there are no citable claims', async () => {
    const client = new FakeLLMClient(
      [],
      [
        synthesisText('I cannot verify current pricing from these sources.', {
          label: 'Postgres hosting pricing',
          entities: [],
          claims: [],
          used_sources: [],
          supersedes_id: null,
        }),
      ],
    );

    const { result } = await run(client);
    expect(result.snapshot).toBeNull();
  });

  it('only accepts a supersedes id that was in the plan', async () => {
    const allowedPlan: PlannerOutput = {
      ...PLAN,
      verify_snapshot_ids: ['snap_allowed'],
    };
    const trailer = { ...TRAILER, supersedes_id: 'snap_allowed' };

    const client = new FakeLLMClient(
      [],
      [synthesisText('Updated [1].', trailer)],
    );

    const { result } = await run(client, context({ plan: allowedPlan }));
    expect(result.snapshot?.supersedesId).toBe('snap_allowed');

    const second = new FakeLLMClient(
      [],
      [synthesisText('Updated [1].', { ...TRAILER, supersedes_id: 'snap_other' })],
    );
    const { result: result2 } = await run(second);
    expect(result2.snapshot?.supersedesId).toBeNull();
  });

  it('throws when the trailer is missing', async () => {
    const client = new FakeLLMClient([], ['Just an answer, no trailer.']);
    await expect(run(client)).rejects.toThrow(/JSON trailer/);
  });

  it('throws on an empty answer', async () => {
    const client = new FakeLLMClient(
      [],
      [synthesisText('   ', TRAILER)],
    );
    await expect(run(client)).rejects.toThrow(/empty answer/);
  });

  it('sends the numbered sources and recalled claims to the model', async () => {
    const client = new FakeLLMClient([], [synthesisText('ok [2].', TRAILER)]);
    await run(client, context({ recall: RECALL }));

    const user = client.streamCalls[0]?.messages[1]?.content ?? '';
    expect(user).toContain('[1] Supabase Pricing');
    expect(user).toContain('URL: https://neon.com/pricing');
    expect(user).toContain('RECALLED MEMORY');
    expect(user).toContain('snap_postgres');
    expect(user).toContain('$25/mo');
    expect(user).toContain('https://supabase.com/pricing');
    expect(user).toContain('NOW_UTC: 2026-11-18T12:00:00.000Z');
  });

  it('says so plainly when nothing was recalled', async () => {
    const client = new FakeLLMClient([], [synthesisText('ok [1].', TRAILER)]);
    await run(client);

    const user = client.streamCalls[0]?.messages[1]?.content ?? '';
    expect(user).toContain('(no stored memories matched this question)');
  });

  it('allows superseding a recalled snapshot without a verify id', async () => {
    const trailer = { ...TRAILER, supersedes_id: 'snap_postgres' };
    const client = new FakeLLMClient(
      [],
      [synthesisText('Updated [1].', trailer)],
    );

    const { result } = await run(client, context({ recall: RECALL }));

    expect(result.snapshot?.supersedesId).toBe('snap_postgres');
  });
});
