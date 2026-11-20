import type { JsonRequest, JsonResponse, LLMClient } from '../../src/llm/types';
import type { PlannerOutput } from '../../src/types';

/**
 * Deterministic LLM double. Returns queued raw strings (or throws queued
 * errors) and records every request, so prompts and retries are testable
 * without a network.
 */
export class FakeLLMClient implements LLMClient {
  readonly model = 'fake-llm';
  readonly calls: JsonRequest[] = [];
  private readonly queue: Array<string | Error>;

  constructor(responses: ReadonlyArray<string | Error>) {
    this.queue = [...responses];
  }

  get callCount(): number {
    return this.calls.length;
  }

  async json(request: JsonRequest): Promise<JsonResponse> {
    this.calls.push({
      ...request,
      messages: request.messages.map((message) => ({ ...message })),
    });

    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error('FakeLLMClient: no response queued');
    }
    if (next instanceof Error) throw next;

    return { text: next, model: this.model };
  }
}

export const FIXED_NOW = new Date('2026-11-18T12:00:00.000Z');

export function plannerJson(
  overrides: Partial<PlannerOutput> = {},
): string {
  return JSON.stringify({
    intent: 'change',
    now_iso: '2000-01-01T00:00:00.000Z',
    temporal_refs: [
      {
        expression: 'last Tuesday',
        resolved_range: [
          '2026-11-10T00:00:00.000Z',
          '2026-11-10T23:59:59.999Z',
        ],
      },
    ],
    memory: {
      window: ['2026-11-10T00:00:00.000Z', '2026-11-10T23:59:59.999Z'],
      keywords: ['postgres', 'hosting'],
    },
    search_plan: [
      { query: 'Supabase pricing', mode: 'quick', since: '2026-11-10' },
    ],
    verify_snapshot_ids: [],
    ...overrides,
  });
}
