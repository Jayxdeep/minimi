import type { LLMClient } from '../llm/types';
import { memorySnapshotIds, type MemoryEntry } from '../memory';
import type { SearchGroup } from '../search/types';
import type { PlannerOutput } from '../types';
import { AnswerSplitter } from './fence';
import { buildSynthesisMessages } from './prompt';
import { buildEvidence, flattenSources } from './sources';
import {
  SynthesisTrailerSchema,
  type SynthesisResult,
  type SynthesisTrailer,
} from './types';

export type {
  ClaimDraft,
  SynthesisResult,
  SynthesisSnapshot,
  SynthesisTrailer,
} from './types';
export {
  SynthesisTrailerSchema,
  ClaimDraftSchema,
} from './types';

export class SynthesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SynthesisError';
  }
}

export interface SynthesisContext {
  message: string;
  now: Date;
  userTz: string;
  plan: PlannerOutput;
  memoryIndex: readonly MemoryEntry[];
  groups: readonly SearchGroup[];
  signal?: AbortSignal;
}

export interface Synthesizer {
  run(
    context: SynthesisContext,
    onToken: (text: string) => void,
  ): Promise<SynthesisResult>;
}

/** Parse the fenced block, tolerating a missing closing fence or trailing prose. */
export function parseTrailer(raw: string): SynthesisTrailer {
  const closing = raw.indexOf('```');
  const jsonText = (closing === -1 ? raw : raw.slice(0, closing)).trim();

  if (jsonText.length === 0) {
    throw new SynthesisError('The response ended without a JSON trailer.');
  }

  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SynthesisError(`The JSON trailer was invalid: ${detail}`);
  }

  const parsed = SynthesisTrailerSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new SynthesisError(`The JSON trailer failed validation: ${issues}`);
  }

  return parsed.data;
}

export function createSynthesizer(client: LLMClient): Synthesizer {
  return {
    async run(context, onToken) {
      const flat = flattenSources(context.groups);
      const messages = buildSynthesisMessages({
        message: context.message,
        now: context.now,
        userTz: context.userTz,
        plan: context.plan,
        memoryIndex: context.memoryIndex,
        flat,
      });

      const splitter = new AnswerSplitter();

      for await (const delta of client.streamText({
        messages,
        temperature: 0.3,
        maxTokens: 2_500,
        ...(context.signal ? { signal: context.signal } : {}),
      })) {
        const out = splitter.push(delta);
        if (out.length > 0) onToken(out);
      }

      const { answer, remainder, trailerText } = splitter.finish();
      if (remainder.length > 0) onToken(remainder);

      if (answer.trim().length === 0) {
        throw new SynthesisError('The model returned an empty answer.');
      }
      if (trailerText === null) {
        throw new SynthesisError('The answer ended without a JSON trailer.');
      }

      const trailer = parseTrailer(trailerText);
      const { claims, sources } = buildEvidence(trailer, flat, context.now);

      const allowedSnapshots = new Set<string>([
        ...memorySnapshotIds(context.memoryIndex),
        ...context.plan.verify_snapshot_ids,
      ]);

      const supersedesId =
        trailer.supersedes_id !== null && allowedSnapshots.has(trailer.supersedes_id)
          ? trailer.supersedes_id
          : null;

      const label =
        trailer.label.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled topic';
      const entities = [
        ...new Set(
          trailer.entities
            .map((entity) => entity.replace(/\s+/g, ' ').trim().slice(0, 80))
            .filter((entity) => entity.length > 0),
        ),
      ].slice(0, 12);

      return {
        answer,
        snapshot:
          claims.length > 0
            ? { label, entities, claims, sources, supersedesId }
            : null,
      } satisfies SynthesisResult;
    },
  };
}
