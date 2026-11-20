import { describe, expect, it } from 'vitest';
import {
  createPlanner,
  degradedPlan,
  extractJsonObject,
  MAX_PLANNER_ATTEMPTS,
  PlannerError,
  type PlannerContext,
} from '../src/planner';
import type { PlannerOutput } from '../src/types';
import { FIXED_NOW, FakeLLMClient, plannerJson } from './helpers/fake-llm';

function context(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    now: FIXED_NOW,
    userTz: 'Europe/London',
    memoryIndex: [],
    ...overrides,
  };
}

const SNAPSHOT_ENTRY: PlannerContext['memoryIndex'][number] = {
  kind: 'snapshot',
  at: '2026-11-17T10:00:00.000Z',
  id: 'snap_abc',
  label: 'Postgres hosting',
  entities: ['Supabase', 'Neon'],
  claimSubjects: ['Supabase/pricing'],
};

describe('planner: parsing', () => {
  it('accepts a bare JSON object and owns the clock', async () => {
    const llm = new FakeLLMClient([plannerJson()]);
    const planner = createPlanner(llm);

    const result = await planner.plan('has pricing changed?', context());

    expect(result.attempts).toBe(1);
    expect(result.plan.intent).toBe('change');
    // The model said 2000; code overwrites it.
    expect(result.plan.now_iso).toBe(FIXED_NOW.toISOString());
    expect(result.plan.search_plan).toEqual([
      { query: 'Supabase pricing', mode: 'quick', since: '2026-11-10' },
    ]);
  });

  it('tolerates fenced JSON and surrounding prose', async () => {
    const fenced = `Here is the plan:\n\`\`\`json\n${plannerJson()}\n\`\`\`\nDone.`;
    const llm = new FakeLLMClient([fenced]);

    const result = await createPlanner(llm).plan('hello', context());

    expect(result.plan.intent).toBe('change');
  });

  it('extracts the last fenced block when several exist', () => {
    expect(
      extractJsonObject('```json\n{"a":1}\n```\ntext\n```json\n{"b":2}\n```'),
    ).toBe('{"b":2}');
  });

  it('returns null when there is no object', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });
});

describe('planner: the single retry', () => {
  it('retries once with the validation error and succeeds', async () => {
    const llm = new FakeLLMClient(['not json at all', plannerJson()]);
    const planner = createPlanner(llm);

    const result = await planner.plan('compare hosting', context());

    expect(result.attempts).toBe(2);
    expect(llm.callCount).toBe(2);

    const retry = llm.calls[1];
    expect(retry?.messages).toHaveLength(4);
    expect(retry?.messages[2]?.role).toBe('assistant');
    expect(retry?.messages[3]?.content).toContain('failed validation');
  });

  it('gives up after exactly two attempts', async () => {
    const llm = new FakeLLMClient(['{"intent":"nope"}', 'still not valid']);
    const planner = createPlanner(llm);

    await expect(planner.plan('x', context())).rejects.toBeInstanceOf(PlannerError);
    expect(llm.callCount).toBe(MAX_PLANNER_ATTEMPTS);
  });

  it('does not retry transport failures', async () => {
    const llm = new FakeLLMClient([new Error('network down')]);

    await expect(createPlanner(llm).plan('x', context())).rejects.toThrow(
      'network down',
    );
    expect(llm.callCount).toBe(1);
  });
});

describe('planner: deterministic sanitisation', () => {
  it('drops implausible and inverted date ranges', async () => {
    const llm = new FakeLLMClient([
      plannerJson({
        temporal_refs: [
          {
            expression: 'the nineties',
            resolved_range: ['1994-01-01T00:00:00.000Z', '1994-01-02T00:00:00.000Z'],
          },
          {
            expression: 'backwards',
            resolved_range: ['2026-11-12T00:00:00.000Z', '2026-11-10T00:00:00.000Z'],
          },
          {
            expression: 'yesterday',
            resolved_range: ['2026-11-17T00:00:00.000Z', '2026-11-17T23:59:59.999Z'],
          },
        ],
        memory: {
          window: ['1994-01-01T00:00:00.000Z', '1994-01-02T00:00:00.000Z'],
          keywords: ['hosting'],
        },
      }),
    ]);

    const { plan } = await createPlanner(llm).plan('x', context());

    expect(plan.temporal_refs).toHaveLength(1);
    expect(plan.temporal_refs[0]?.expression).toBe('yesterday');
    expect(plan.memory.window).toBeNull();
  });

  it('only allows snapshot ids that were actually shown to the planner', async () => {
    const llm = new FakeLLMClient([
      plannerJson({ verify_snapshot_ids: ['snap_abc', 'snap_invented'] }),
    ]);

    const { plan } = await createPlanner(llm).plan('is it still true?', context({
      memoryIndex: [SNAPSHOT_ENTRY],
    }));

    expect(plan.verify_snapshot_ids).toEqual(['snap_abc']);
  });

  it('caps, dedupes and cleans the search plan', async () => {
    const llm = new FakeLLMClient([
      plannerJson({
        search_plan: [
          { query: '  Supabase   pricing ', mode: 'quick', since: '2026-11-10' },
          { query: 'supabase pricing', mode: 'quick' },
          { query: '   ', mode: 'quick' },
          { query: 'Neon pricing', mode: 'news', since: 'not-a-date' },
          { query: 'p3', mode: 'quick' },
          { query: 'p4', mode: 'quick' },
          { query: 'p5', mode: 'quick' },
        ],
      }),
    ]);

    const { plan } = await createPlanner(llm).plan('x', context());

    expect(plan.search_plan).toHaveLength(4);
    expect(plan.search_plan[0]).toEqual({
      query: 'Supabase pricing',
      mode: 'quick',
      since: '2026-11-10',
    });
    expect(plan.search_plan[1]).toEqual({ query: 'Neon pricing', mode: 'news' });
  });

  it('normalises and caps keywords', async () => {
    const llm = new FakeLLMClient([
      plannerJson({
        memory: {
          window: null,
          keywords: [
            'Postgres',
            'HOSTING',
            'postgres',
            'a',
            'b',
            'c',
            'd',
            'e',
            'f',
            'g',
          ],
        },
      }),
    ]);

    const { plan } = await createPlanner(llm).plan('x', context());

    expect(plan.memory.keywords).toEqual([
      'postgres',
      'hosting',
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
  });

  it('passes the disconnect signal through to the client', async () => {
    const controller = new AbortController();
    const llm = new FakeLLMClient([plannerJson()]);

    await createPlanner(llm).plan('x', context({ signal: controller.signal }));

    expect(llm.calls[0]?.signal).toBe(controller.signal);
  });
});

describe('planner: prompt', () => {
  it('injects the clock, timezone and memory index', async () => {
    const llm = new FakeLLMClient([plannerJson()]);

    await createPlanner(llm).plan('what did I ask last Tuesday?', context({
      memoryIndex: [SNAPSHOT_ENTRY],
    }));

    const system = llm.calls[0]?.messages[0]?.content ?? '';
    const user = llm.calls[0]?.messages[1]?.content ?? '';

    expect(system).toContain('ONE JSON object');
    expect(system).toContain('JSON');
    expect(user).toContain('NOW_UTC: 2026-11-18T12:00:00.000Z');
    expect(user).toContain('Europe/London');
    expect(user).toContain('snap_abc');
    expect(user).toContain('what did I ask last Tuesday?');
  });

  it('sends a warm temperature of 0 for determinism', async () => {
    const llm = new FakeLLMClient([plannerJson()]);
    await createPlanner(llm).plan('x', context());
    expect(llm.calls[0]?.temperature).toBe(0);
  });
});

describe('degradedPlan', () => {
  it('is a valid chat plan with no side effects', () => {
    const plan: PlannerOutput = degradedPlan(FIXED_NOW);

    expect(plan.intent).toBe('chat');
    expect(plan.now_iso).toBe(FIXED_NOW.toISOString());
    expect(plan.search_plan).toEqual([]);
    expect(plan.memory.window).toBeNull();
    expect(plan.verify_snapshot_ids).toEqual([]);
  });
});
