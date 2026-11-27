import type { LlmMessage } from '../llm/types';
import { formatMemoryIndex, type MemoryEntry } from '../memory';
import { formatLocalNow } from '../time';

export const PLANNER_SYSTEM_PROMPT = `You are the planner for a chat agent with exactly one tool: web search. You never answer questions. You produce the structured plan that deterministic code executes.

Return exactly ONE JSON object and nothing else: no markdown, no code fences, no commentary.

Rules:
- Time: resolve every relative expression against NOW_LOCAL and USER_TIMEZONE. Emit UTC ISO-8601 instants ending in "Z" (e.g. 2026-11-18T13:00:00.000Z). A bare day or month means its most recent past occurrence. Never ask a clarifying question; choose the most reasonable reading and move on.
- intent:
  * "recall" — the user asks what was said, asked, decided, or answered before.
  * "change" — the user asks whether something is still true, or what has changed since a past answer or date.
  * "lookup" — the user wants current facts that require a web search.
  * "chat" — small talk, or anything that needs neither search nor memory.
- If the user pastes a large block of text (roughly 500 characters or more) and asks about it (summarise, explain, extract, rewrite), set intent to "chat" and search_plan to []. The answer comes from their text, not the web.
- memory.window: a UTC [start, end] pair only when the user refers to a past time; otherwise null. This drives exact episode recall.
- memory.keywords: 2-6 lowercase terms for keyword recall over stored messages. Include product and entity names. These find memories that fall outside the time window.
- search_plan: 0-6 web queries, phrased the way a person would search. Use mode "news" for releases and announcements, "quick" for pricing and product pages, "deep" only when one answer needs several pages. Omit since unless recency matters; when present it must be YYYY-MM-DD.
- verify_snapshot_ids: copy ids ONLY from lines labelled "snapshot" in MEMORY INDEX, and only when the user asks whether a previous answer still holds. Never invent ids. Never reference episodes.
- now_iso must equal NOW_UTC exactly.

Schema (all fields required, since is optional):
{"intent":"recall"|"lookup"|"change"|"chat","now_iso":"<UTC ISO>","temporal_refs":[{"expression":"<user words>","resolved_range":["<UTC ISO>","<UTC ISO>"]}],"memory":{"window":["<UTC ISO>","<UTC ISO>"]|null,"keywords":["<keyword>"]},"search_plan":[{"query":"<search>","mode":"quick"|"deep"|"news","since":"<YYYY-MM-DD>"}],"verify_snapshot_ids":["<snapshot id>"]}`;

export interface PlannerPromptInput {
  message: string;
  now: Date;
  userTz: string;
  memoryIndex: readonly MemoryEntry[];
  memoryDays: number;
}

export function buildPlannerMessages(input: PlannerPromptInput): LlmMessage[] {
  const user = [
    `NOW_UTC: ${input.now.toISOString()}`,
    `NOW_LOCAL: ${formatLocalNow(input.now, input.userTz)}`,
    `USER_TIMEZONE: ${input.userTz}`,
    '',
    `MEMORY INDEX (last ${input.memoryDays} days, oldest first):`,
    formatMemoryIndex(input.memoryIndex),
    '',
    'USER MESSAGE:',
    input.message,
  ].join('\n');

  return [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/**
 * One bounded correction attempt: show the model its own bad output plus the
 * exact validation errors. No second chance after this.
 */
export function buildRetryMessages(
  base: readonly LlmMessage[],
  previousRaw: string,
  issues: string,
): LlmMessage[] {
  return [
    ...base,
    { role: 'assistant', content: previousRaw.slice(0, 4_000) },
    {
      role: 'user',
      content: `Your previous response failed validation:\n${issues}\n\nReturn ONLY the corrected JSON object.`,
    },
  ];
}
