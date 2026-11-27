/**
 * The provider seam. Everything above this line is our architecture; everything
 * below it is swappable in one `.env` change.
 *
 * Phase 1 only needs JSON completion. Streaming text arrives with the
 * synthesizer in Phase 3.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonRequest {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Caller-owned cancellation. Honoured by providers that support it. */
  signal?: AbortSignal;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface JsonResponse {
  text: string;
  model: string;
  usage?: LlmUsage;
}

export interface TextRequest {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMClient {
  readonly model: string;
  /** Return raw text that is expected (but not guaranteed) to contain JSON. */
  json(request: JsonRequest): Promise<JsonResponse>;
  /** Stream answer text deltas. Used by the synthesizer. */
  streamText(request: TextRequest): AsyncIterable<string>;
}

export class LlmError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'LlmError';
    this.cause = cause;
  }
}
