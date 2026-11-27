import OpenAI from 'openai';
import {
  LlmError,
  type JsonRequest,
  type JsonResponse,
  type LLMClient,
  type LlmUsage,
  type TextRequest,
} from './types';

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** Transport-level retries only. Schema retries belong to the planner. */
  maxRetries?: number;
}

/**
 * DeepSeek exposes an OpenAI-compatible chat completions endpoint.
 *
 * JSON mode (`response_format: { type: 'json_object' }`) guarantees valid JSON
 * syntax, not a valid schema, and DeepSeek has no `strict: true`. So the caller
 * always validates with Zod and owns the single allowed retry.
 */
export class DeepSeekClient implements LLMClient {
  readonly model: string;
  private readonly client: OpenAI;

  constructor(options: DeepSeekClientOptions) {
    if (!options.apiKey) {
      throw new LlmError('DEEPSEEK_API_KEY is required to construct DeepSeekClient');
    }

    this.model = options.model;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries ?? 1,
    });
  }

  async json(request: JsonRequest): Promise<JsonResponse> {
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: request.messages,
          temperature: request.temperature ?? 0,
          max_tokens: request.maxTokens ?? 1_200,
          response_format: { type: 'json_object' },
          stream: false,
        },
        { signal: request.signal },
      );

      const choice = completion.choices[0];
      const text = choice?.message?.content;

      if (!text || text.trim().length === 0) {
        // A documented DeepSeek quirk: JSON mode occasionally returns an empty
        // message. Treat it as a provider failure, not as a valid plan.
        throw new LlmError('DeepSeek returned an empty message');
      }

      const usage: LlmUsage | undefined = completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
          }
        : undefined;

      return {
        text,
        model: completion.model || this.model,
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      if (error instanceof LlmError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new LlmError(`DeepSeek request failed: ${detail}`, error);
    }
  }

  /**
   * Streaming completion. No response_format here: the synthesizer writes
   * markdown and ends with a fenced JSON block, which the caller splits.
   */
  async *streamText(request: TextRequest): AsyncGenerator<string> {
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: request.messages,
          temperature: request.temperature ?? 0.3,
          max_tokens: request.maxTokens ?? 2_500,
          stream: true,
        },
        request.signal ? { signal: request.signal } : {},
      );

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    } catch (error) {
      if (error instanceof LlmError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new LlmError(`DeepSeek stream failed: ${detail}`, error);
    }
  }
}
