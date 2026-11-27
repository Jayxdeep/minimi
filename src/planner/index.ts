import type { LLMClient } from '../llm/types';
import { memorySnapshotIds, type MemoryEntry } from '../memory';
import { clampRange, DATE_ONLY } from '../time';
import { PlannerOutputSchema, type PlannerOutput } from '../types';
import {
  buildPlannerMessages,
  buildRetryMessages,
  type PlannerPromptInput,
} from './prompt';

export interface PlannerContext {
  now: Date;
  userTz: string;
  memoryIndex: readonly MemoryEntry[];
  /** Aborted if the client disconnects mid-plan, so we stop paying for tokens. */
  signal?: AbortSignal;
}

export interface PlannerResult {
  plan: PlannerOutput;
  /** 1 = first attempt valid, 2 = recovered on the single allowed retry. */
  attempts: number;
}

export interface Planner {
  plan(message: string, context: PlannerContext): Promise<PlannerResult>;
}

export class PlannerError extends Error {
  readonly issues: string;

  constructor(issues: string) {
    super('Planner failed schema validation after 2 attempts');
    this.name = 'PlannerError';
    this.issues = issues;
  }
}

/** Exactly one retry. Hard cap, not a setting. */
export const MAX_PLANNER_ATTEMPTS = 2;

const MAX_SEARCH_QUERIES = 6;
const MAX_KEYWORDS = 8;
const MAX_KEYWORD_CHARS = 40;
const MAX_QUERY_CHARS = 200;

/**
 * A pasted block this large is context to reason over, not a search query.
 * Prompt guidance alone is not enough, so the planner clamps it in code.
 */
export const PASTED_TEXT_MIN_CHARS = 500;

export function isLargePastedText(message: string): boolean {
  return message.trim().length >= PASTED_TEXT_MIN_CHARS;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * DeepSeek's JSON mode usually returns bare JSON, but fences and stray prose
 * happen. Take the last fenced block when present, then the outermost braces.
 */
export function extractJsonObject(text: string): string | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const candidate =
    fences.length > 0 ? (fences[fences.length - 1]?.[1] ?? text) : text;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  return candidate.slice(start, end + 1);
}

type ParseResult =
  | { ok: true; value: PlannerOutput }
  | { ok: false; issues: string };

export function parsePlannerOutput(raw: string): ParseResult {
  const json = extractJsonObject(raw);
  if (json === null) {
    return { ok: false, issues: 'No JSON object found in the response.' };
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: `Invalid JSON: ${detail}` };
  }

  const result = PlannerOutputSchema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n'),
    };
  }

  return { ok: true, value: result.data };
}

/* -------------------------------------------------------------------------- */
/* Deterministic sanitisation ("AI proposes, code disposes")                   */
/* -------------------------------------------------------------------------- */

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }

  return out;
}

export function finalizePlan(plan: PlannerOutput, context: PlannerContext): PlannerOutput {
  const temporal_refs: PlannerOutput['temporal_refs'] = [];

  for (const ref of plan.temporal_refs) {
    const clamped = clampRange(ref.resolved_range, context.now);
    if (!clamped) continue;
    temporal_refs.push({
      expression: ref.expression,
      resolved_range: clamped,
    });
  }

  const window = plan.memory.window
    ? clampRange(plan.memory.window, context.now)
    : null;

  const keywords = dedupe(
    plan.memory.keywords
      .flatMap((keyword) => keyword.toLowerCase().split(/\s+/))
      .map((keyword) => keyword.trim().slice(0, MAX_KEYWORD_CHARS))
      .filter((keyword) => keyword.length > 0),
  ).slice(0, MAX_KEYWORDS);

  const allowedSnapshots = memorySnapshotIds(context.memoryIndex);

  const search_plan: PlannerOutput['search_plan'] = [];
  const seenQueries = new Set<string>();

  for (const item of plan.search_plan) {
    const query = item.query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
    if (query.length === 0) continue;

    const key = query.toLowerCase();
    if (seenQueries.has(key)) continue;
    seenQueries.add(key);

    const entry: PlannerOutput['search_plan'][number] = {
      query,
      mode: item.mode,
    };
    if (item.since && DATE_ONLY.test(item.since)) entry.since = item.since;

    search_plan.push(entry);
    if (search_plan.length >= MAX_SEARCH_QUERIES) break;
  }

  return {
    intent: plan.intent,
    // Code owns the clock; the model's value is never trusted.
    now_iso: context.now.toISOString(),
    temporal_refs,
    memory: { window, keywords },
    search_plan,
    verify_snapshot_ids: dedupe(
      plan.verify_snapshot_ids.filter((id) => allowedSnapshots.has(id)),
    ),
  };
}

export function degradedPlan(now: Date): PlannerOutput {
  return {
    intent: 'chat',
    now_iso: now.toISOString(),
    temporal_refs: [],
    memory: { window: null, keywords: [] },
    search_plan: [],
    verify_snapshot_ids: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Planner                                                                     */
/* -------------------------------------------------------------------------- */

export interface PlannerOptions {
  memoryDays?: number;
}

export function createPlanner(
  client: LLMClient,
  options: PlannerOptions = {},
): Planner {
  const memoryDays = options.memoryDays ?? 30;

  return {
    async plan(message, context) {
      const base = buildPlannerMessages({
        message,
        now: context.now,
        userTz: context.userTz,
        memoryIndex: context.memoryIndex,
        memoryDays,
      } satisfies PlannerPromptInput);

      let messages = base;
      let lastIssues = 'unknown validation failure';

      for (let attempt = 1; attempt <= MAX_PLANNER_ATTEMPTS; attempt += 1) {
        const response = await client.json({
          messages,
          temperature: 0,
          maxTokens: 1_200,
          ...(context.signal ? { signal: context.signal } : {}),
        });

        const parsed = parsePlannerOutput(response.text);

        if (parsed.ok) {
          const plan = finalizePlan(parsed.value, context);

          // Deterministic guardrail: a pasted document is answered from itself.
          if (isLargePastedText(message)) {
            return {
              plan: { ...plan, intent: 'chat', search_plan: [] },
              attempts: attempt,
            };
          }

          return { plan, attempts: attempt };
        }

        lastIssues = parsed.issues;

        if (attempt < MAX_PLANNER_ATTEMPTS) {
          messages = buildRetryMessages(base, response.text, lastIssues);
        }
      }

      throw new PlannerError(lastIssues);
    },
  };
}
