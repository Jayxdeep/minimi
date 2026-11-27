import type {
  JsonRequest,
  JsonResponse,
  LLMClient,
  TextRequest,
} from '../../src/llm/types';
import type { PlannerOutput } from '../../src/types';

/**
 * Deterministic LLM double. Queued JSON responses for the planner, queued full
 * texts for the synthesizer (streamed in small chunks so the fence splitter is
 * exercised across boundaries).
 */
export class FakeLLMClient implements LLMClient {
  readonly model = 'fake-llm';
  readonly calls: JsonRequest[] = [];
  readonly streamCalls: TextRequest[] = [];
  private readonly jsonQueue: Array<string | Error>;
  private readonly textQueue: Array<string | Error>;

  constructor(
    jsonResponses: ReadonlyArray<string | Error> = [],
    textResponses: ReadonlyArray<string | Error> = [],
  ) {
    this.jsonQueue = [...jsonResponses];
    this.textQueue = [...textResponses];
  }

  get callCount(): number {
    return this.calls.length;
  }

  get streamCount(): number {
    return this.streamCalls.length;
  }

  async json(request: JsonRequest): Promise<JsonResponse> {
    this.calls.push({
      ...request,
      messages: request.messages.map((message) => ({ ...message })),
    });

    const next = this.jsonQueue.shift();
    if (next === undefined) {
      throw new Error('FakeLLMClient: no JSON response queued');
    }
    if (next instanceof Error) throw next;

    return { text: next, model: this.model };
  }

  async *streamText(request: TextRequest): AsyncGenerator<string> {
    this.streamCalls.push({
      ...request,
      messages: request.messages.map((message) => ({ ...message })),
    });

    const next = this.textQueue.shift();
    if (next === undefined) {
      throw new Error('FakeLLMClient: no text response queued');
    }
    if (next instanceof Error) throw next;

    for (let index = 0; index < next.length; index += 5) {
      yield next.slice(index, index + 5);
    }
  }
}

export const FIXED_NOW = new Date('2026-11-18T12:00:00.000Z');

export function plannerJson(overrides: Partial<PlannerOutput> = {}): string {
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

/** A complete synthesizer response: markdown answer + fenced trailer. */
export function synthesisText(
  answer: string,
  trailer: Record<string, unknown>,
): string {
  return `${answer}\n\n\`\`\`json\n${JSON.stringify(trailer, null, 2)}\n\`\`\`\n`;
}
